const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const GhostAdminAPI = require('@tryghost/admin-api');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const app = express();
app.use(bodyParser.json());

// Initialize the Secret Manager client
const secretManagerClient = new SecretManagerServiceClient();

// Access secrets from Google Cloud Secret Manager
async function accessSecret(secretName) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const [version] = await secretManagerClient.accessSecretVersion({
    name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
  });
  return version.payload.data.toString();
}

// Configure the Ghost Admin API with your web and admin key details stored in secrets
async function configureGhostApi() {
  const url = await accessSecret('ghost_url');
  const key = await accessSecret('ghost_key');

  return new GhostAdminAPI({
    url,
    key,
    version: "v5.0",
  });
}

// Load secrets and configure the Ghost API
let ghostApi;
(async () => {
  ghostApi = await configureGhostApi();
})();

// Verify the Strava webhook setup
app.get('/', async (req, res) => {
  const verifyToken = await accessSecret('strava_verify_token');

  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    console.log('Verified webhook setup with Strava.');
    res.status(200).json({ 'hub.challenge': req.query['hub.challenge'] });
  } else {
    console.log('Failed verification with Strava.');
    res.status(403).send('Failed verification');
  }
});

// Main handler for Strava webhook events
app.post('/', async (req, res) => {
  if (!req.body.aspect_type || !req.body.object_id) {
    console.error('Missing required fields: aspect_type or object_id.');
    return res.status(400).json({ message: "This endpoint expects aspect_type and object_id in the request." });
  }

  console.log('Webhook event received:', req.body);

  try {
    const { object_id: objectId, aspect_type: aspectType } = req.body;

    // Check if the event is a delete event and handle accordingly
    if (aspectType === 'delete') {
      console.log(`Received delete event for activity ID: ${objectId}`);
      await deletePostByActivityId(objectId);
      console.log(`Attempted to delete post for activity ID: ${objectId}`);
      return res.status(200).send('Delete event processed successfully.');
    }

    console.log(`Received ${aspectType} event for activity ID: ${objectId}`);

    // For create events, add a short delay before fetching activity details
    if (aspectType === 'create') {
      const delaySeconds = 15;
      console.log(`Waiting for ${delaySeconds} seconds before fetching activity details for new activity ID: ${objectId}`);
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }

    // For create and update events, attempt to fetch activity details
    const activityDetails = await fetchActivityDetails(objectId);

    if (!activityDetails) {
      console.error(`Activity ID ${objectId} not found or is not accessible. Skipping.`);
      return res.status(404).send('Activity not found or is not accessible.');
    }

    // For create and update events, check if a post already exists and update or create accordingly
    const existingPost = await findPostByActivityId(activityDetails.embedId);
    if (existingPost) {
      await updateGhostPost(existingPost, activityDetails);
      console.log(`Updated post for activity ID: ${activityDetails.embedId}`);
    } else {
      await createGhostPost(activityDetails);
      console.log(`Created new post for activity ID: ${activityDetails.embedId}`);
    }
    res.status(200).send('Post created or updated successfully.');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Fetch activity details from Strava API
async function fetchActivityDetails(activityId, attempt = 0) {
  const maxAttempts = 5; // Maximum number of attempts
  const backoffDelay = 1000; // Initial delay in milliseconds
  let accessToken;

  try {
    accessToken = await accessSecret('strava_access_token');
    const url = `https://www.strava.com/api/v3/activities/${activityId}?access_token=${accessToken}`;
    console.log(`Attempting to fetch details for Activity ID: ${activityId} with Access Token: ${accessToken}`);

    const response = await fetch(url);
    const data = await response.json();

    console.log(`Response from Strava API for Activity ID: ${activityId}: ${JSON.stringify(data)}`);

    // Log the access token and full API response
    console.log(`Access Token used for Activity ID: ${activityId}: ${accessToken}`);
    console.log(`Full API response for Activity ID: ${activityId}:`, data);

    if (data.errors) {
      console.error(`Strava API error for activity ID ${activityId}:`, JSON.stringify(data.errors));
      return null;
    }

    return {
      title: data.name,
      type: data.type,
      embedId: data.id,
    };
  } catch (error) {
    console.error(`Error fetching activity details for ID: ${activityId}`, error);

    // Retry the request if the maximum number of attempts have not been reached
    if (attempt < maxAttempts) {
      console.log(`Retrying... Attempt ${attempt + 1} of ${maxAttempts}`);
      // Wait for a delay that increases with each attempt
      await new Promise(resolve => setTimeout(resolve, backoffDelay * Math.pow(2, attempt)));
      return fetchActivityDetails(activityId, attempt + 1); // Recursively retry
    } else {
      console.error('Maximum retry attempts reached. Unable to fetch details for Activity ID:', activityId);
      return null;
    }
  }
}

// Search for a post in Ghost using the Strava activity ID to check if it already exists
async function findPostByActivityId(activityId) {
  try {
    const posts = await ghostApi.posts.browse({ limit: 'all', filter: 'tags:[Strava]', formats: 'html' });
    const matchingPost = posts.find(post => post.html && post.html.includes(`data-embed-id="${activityId}"`));
    console.log(`Searching for post with activity ID: ${activityId}, found:`, matchingPost ? 'Yes' : 'No');
    return matchingPost || null;
  } catch (error) {
    console.error(`Error finding post by activity ID: ${activityId}`, error);
    throw error;
  }
}

// If Strava sends an update event, update the corresponding post
async function updateGhostPost(post, activityDetails) {
  const htmlContent = `
<!--kg-card-begin: html-->
<div class="strava-embed-placeholder" data-embed-type="activity" data-embed-id="${activityDetails.embedId}" data-style="standard"></div>
<script src="https://strava-embeds.com/embed.js"></script>
<!--kg-card-end: html-->`;

  console.log(`Attempting to update post with HTML content: ${htmlContent}`); // Debugging log

  try {
    const response = await ghostApi.posts.edit(
      {
        id: post.id,
        title: activityDetails.title,
        html: htmlContent,
        tags: [`${activityDetails.type}`, 'Strava'],
        updated_at: post.updated_at,
        canonical_url: `https://www.strava.com/activities/${activityDetails.embedId}`,
      },
      { source: 'html' }
    );

    console.log(`Ghost API response for update: ${JSON.stringify(response)}`); // Check API response
    console.log(`Updated post ID: ${post.id} for activity ID: ${activityDetails.embedId}`);
  } catch (error) {
    console.error(`Error updating post for activity ID: ${activityDetails.embedId}`, error);
    throw error;
  }
}

// If Strava sends a new Activity ID, create a new post
async function createGhostPost(activityDetails) {
  const htmlContent = `
<!--kg-card-begin: html-->
<div class="strava-embed-placeholder" data-embed-type="activity" data-embed-id="${activityDetails.embedId}" data-style="standard"></div>
<script src="https://strava-embeds.com/embed.js"></script>
<!--kg-card-end: html-->`;

  console.log(`Attempting to create post with HTML content: ${htmlContent}`); // Debugging log

  try {
    const response = await ghostApi.posts.add(
      {
        title: activityDetails.title,
        html: htmlContent,
        tags: [`${activityDetails.type}`, 'Strava'],
        status: 'published',
        canonical_url: `https://www.strava.com/activities/${activityDetails.embedId}`,
      },
      { source: 'html' }
    );

    console.log(`Ghost API response for create:`, JSON.stringify(response, null, 2)); // Enhanced logging
    console.log(`Created new post for activity ID: ${activityDetails.embedId}`);
  } catch (error) {
    console.error(`Error creating new post for activity ID: ${activityDetails.embedId}`, error);
    throw error;
  }
}

// If Strava sends a delete event, delete the corresponding post
async function deletePostByActivityId(activityId) {
  try {
    // Browse all posts tagged with 'Strava'
    const posts = await ghostApi.posts.browse({ filter: 'tag:Strava', limit: 'all', formats: 'html' });
    let found = false;

    for (let post of posts) {
      // Check if the post's HTML includes the specific data-embed-id
      if (post.html && post.html.includes(`data-embed-id="${activityId}"`)) {
        // Delete the post if it matches the activity ID
        await ghostApi.posts.delete({ id: post.id });
        console.log(`Deleted post with Strava activity ID: ${activityId}.`);
        found = true;
        break;
      }
    }

    if (!found) {
      console.log(`No post found with Strava activity ID: ${activityId} to delete.`);
    }
  } catch (error) {
    console.error(`Error deleting post with Strava activity ID ${activityId}:`, error);
  }
}

// Export the Express app as a Google Cloud Function named 'stravaToGhostSync'
exports.stravaToGhostSync = app;
