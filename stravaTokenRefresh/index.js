will this handle deleting all but the enabled and latest secrets?

const express = require('express');
const fetch = require('node-fetch');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const app = express();
const secretManagerClient = new SecretManagerServiceClient();

// Google Secret Manager helper functions to access and update secrets
async function accessSecret(secretName) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const [version] = await secretManagerClient.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
  });
  return version.payload.data.toString();
}

// Update secret with new version
async function updateSecret(secretName, secretValue) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const [version] = await secretManagerClient.addSecretVersion({
    parent: `projects/${projectId}/secrets/${secretName}`,
    payload: {
      data: Buffer.from(secretValue),
    },
  });
  console.log(`Updated secret ${secretName} with new version ${version.name}`);
}

// Delete old versions of secret after updating to avoid unnecessary costs
async function deleteOldSecretVersions(secretName) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const parent = `projects/${projectId}/secrets/${secretName}`;

  const [versions] = await secretManagerClient.listSecretVersions({ parent });
  const activeVersions = versions.filter(version => version.state === 'ENABLED');

  // Find the latest active version by sorting ENABLED versions by their createTime in descending order
  const latestActiveVersion = activeVersions.sort((a, b) => new Date(b.createTime) - new Date(a.createTime))[0];

  for (const version of versions) {
    // Check if the version is not the latest active version before deleting
    if (version.name !== latestActiveVersion.name) {
      await secretManagerClient.destroySecretVersion({ name: version.name });
      console.log(`Deleted older version ${version.name} of secret ${secretName}`);
    }
  }
}

// Refresh Strava access token using refresh token
app.get('/', async (req, res) => {
  try {
    const clientId = await accessSecret('strava_client_id');
    const clientSecret = await accessSecret('strava_client_secret');
    const refreshToken = await accessSecret('strava_refresh_token');

    const response = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${refreshToken}&grant_type=refresh_token`,
    });

    const data = await response.json();
    console.log('Refreshed Strava access token:', data);

    await updateSecret('strava_access_token', data.access_token);
    await updateSecret('strava_refresh_token', data.refresh_token);

    await deleteOldSecretVersions('strava_access_token');
    await deleteOldSecretVersions('strava_refresh_token');

    res.status(200).send('Strava access token refreshed successfully');
  } catch (error) {
    console.error('Error refreshing Strava access token:', error);
    res.status(500).send('Error refreshing Strava access token');
  }
});

exports.stravaTokenRefresh = app;
