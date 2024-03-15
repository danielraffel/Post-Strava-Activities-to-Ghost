const express = require('express');
const fetch = require('node-fetch');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const app = express();
const secretManagerClient = new SecretManagerServiceClient();

async function accessSecret(secretName) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const [version] = await secretManagerClient.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
  });
  return version.payload.data.toString();
}

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

    res.status(200).send('Strava access token refreshed successfully');
  } catch (error) {
    console.error('Error refreshing Strava access token:', error);
    res.status(500).send('Error refreshing Strava access token');
  }
});

exports.stravaTokenRefresh = app;
