
### Post Strava Activities to Ghost

The Post Strava Activities to Ghost project enables automated synchronization of Strava activity data with a Ghost blog platform. By leveraging Google Cloud Functions, the Strava API, and the Ghost Admin API, the project can automatically post activities from Strava onto a Ghost blog.

## Pre-requisites

### Ghost Integration

- Create a [custom Ghost integration](https://ghost.org/integrations/custom-integrations/) for your Cloud Function to be able to post and then save the Admin API Key. You will add these to your Google Cloud Secret Manager in a few steps as `ghost_key`.

### Google Cloud Configuration

- **Runtime Environment Variable**: Create a runtime environment variable `GOOGLE_CLOUD_PROJECT` with your Google Cloud project ID for both Cloud Functions (`stravaTokenRefresh` and `stravaToGhostSync`) running on Node.js 20.
- **Service Account IAM Roles**: The service account used by the Cloud Functions must have the following roles:
  - `roles/secretmanager.secretAccessor`: To retrieve secrets.
  - `roles/secretmanager.secretVersionManager`: To manage secret versions.

### Strava Application Creation

- **Create and Approve a Strava App**: Create your app on [Strava Settings API](https://www.strava.com/settings/api) and follow the approval process detailed at [Strava's Getting Started Guide](https://developers.strava.com/docs/getting-started/).

### Strava Authorization Process

1. Construct the authorization URL with your `client_id` and `redirect_uri`, which will prompt you to authorize the app to access your Strava data. The URL format is:

   ```
   https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=YOUR_CALLBACK_URL&approval_prompt=force&scope=read_all,profile:read_all,activity:read_all
   ```

2. After approval, you will be redirected to the callback URI containing a code parameter in the URL. Use this code to exchange for an access token.

3. Exchange the authorization code for an access token using the following `curl` command in a terminal:
   Note: `client_id` and `client_secret` will be available via the Strava My API Application page. Your code will come form the code parameter in the callback URI.

   ```
   curl -X POST https://www.strava.com/oauth/token \
   -d client_id=YOUR_CLIENT_ID \
   -d client_secret=YOUR_CLIENT_SECRET \
   -d code=YOUR_CODE_FROM_REDIRECT_URI \
   -d grant_type=authorization_code
   ```

   You will receive a JSON response containing your `refresh_token` and `access_token`. You will add these to your Google Cloud Secret Manager in a few steps as `strava_refresh_token` and `strava_access_token`.

### Google Cloud Secret Manager

Store the following data in Google Cloud Secret Manager - you may want to do this in phases since you'll have:

- `ghost_url`: Your Ghost blog domain (e.g., `https://yourblog.com`).
- `ghost_key`: Admin API key from your Ghost integration.
- `strava_verify_token`: Unique token you create for one-time verification with Strava.
- `strava_client_id`: Your Strava app client ID from Strava My API Application page.
- `strava_client_secret`: Your Strava app client secret from Strava My API Application page.
- `strava_refresh_token`: Refresh token from Strava terminal response.
- `strava_access_token`: Access token from Strava terminal response.

## Deployment Script

To deploy the cloud functions, you can use the following script. Update `YOUR_PROJECT_ID` and ensure that the `GOOGLE_CLOUD_PROJECT` environment variable is configured for each function:

```bash
#!/bin/bash

# Set your Google Cloud Project ID
export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"

# Deploy the stravaTokenRefresh function
gcloud functions deploy stravaTokenRefresh \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --source

 ./stravaTokenRefresh \
  --entry-point stravaTokenRefresh \
  --project $GOOGLE_CLOUD_PROJECT

# Deploy the stravaToGhostSync function
gcloud functions deploy stravaToGhostSync \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --source ./stravaToGhostSync \
  --entry-point stravaToGhostSync \
  --project $GOOGLE_CLOUD_PROJECT
```

## Setting up the Webhook Subscription

For your `stravaToGhostSync` Cloud Function to receive activity data from Strava, you need to subscribe to Strava's webhook events. I used Postman to do this:

1. Set the HTTP request to `POST`.
2. Use the URL `https://www.strava.com/api/v3/push_subscriptions` for the webhook subscription endpoint.
3. Configure the headers and body as follows:

   **Headers**:
   - `Content-Type`: `application/x-www-form-urlencoded`
   
   **Body**:
   - `client_id`: Value found on your Strava My API Application page.
   - `client_secret`: Value found on your Strava My API Application page.
   - `callback_url`: This is the trigger URL for your `stravaToGhostSync` Cloud Function which you need to publish.
   - `verify_token`: A unique token you create and store in Google Secret Manager as `strava_verify_token`.

After setting up the subscription using a tool like Postman, you will receive a subscription ID in the response indicating successful configuration. This ID is used to verify that the subscription is active and to manage it in the future.

To check the active subscription, you can use the following `curl` command in the terminal:

```bash
curl -G "https://www.strava.com/api/v3/push_subscriptions" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```

Replace `YOUR_CLIENT_ID` and `YOUR_CLIENT_SECRET` with your actual Strava application credentials from Strava My API Application page.

### Google Cloud Scheduler

Set up a Google Cloud Scheduler job to invoke `stravaTokenRefresh/index.js` every 5 hours. This will keep your Strava access token refreshed and valid.

### Conclusion

This README outlines the steps needed to set up the Post Strava to Ghost project, including configuring Google Cloud services, setting up a Strava app, handling OAuth tokens, and deploying Google Cloud Functions. Follow these instructions to ensure smooth operation and automatic synchronization of your Strava activities to your Ghost blog. 
