// index.mjs - ES Modules version of the Lambda handler
import serverless from 'serverless-http';
import app from './app.mjs';

// This is the Lambda function handler
export const handler = serverless(app);