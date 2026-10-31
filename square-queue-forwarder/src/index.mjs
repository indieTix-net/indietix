// Square Webhook Receiver Lambda Function
// This function receives the webhook from Square, returns a 200 response immediately,
// and forwards the request to an SQS queue for asynchronous processing

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

// Initialize SQS client
const sqs = new SQSClient({ region: process.env.AWS_REGION });

export const handler = async (event, context) => {
  console.log("Webhook received from Square"+JSON.stringify(event));
  

  let parsedEvent = event;
  if (typeof event === 'string') {
    try {
      parsedEvent = JSON.parse(event);
      console.log("Converted string event to JSON object");
    } catch (error) {
      console.error("Failed to parse event string as JSON:", error);
    }
  }
  
  console.log("Parsed Event Webhook received from Square:", JSON.stringify(parsedEvent));
  let messageObject = {};
  try {
    // Package all relevant data from the event
    if (process.env.NODE_ENV !== "development") {
      messageObject = {
        // Body from API Gateway
        body: parsedEvent.body,
        
        // Include all headers (important for signature verification)
        headers: parsedEvent.headers,
        
        // Forward path parameters if any
        pathParameters: parsedEvent.pathParameters,
        
        // Forward query string parameters if any
        queryStringParameters: parsedEvent.queryStringParameters,
        
        // Include request context if needed
        requestContext: parsedEvent.requestContext,
        
        // Include timestamp for troubleshooting
        receivedAt: new Date().toISOString()
      };
    }
  else {
     messageObject = {
      // Body from API Gateway
      body: parsedEvent,

      // Include timestamp for troubleshooting
      receivedAt: new Date().toISOString()
    };
  }
    // Log message size (SQS has a 256KB limit)
    const messageSize = Buffer.from(JSON.stringify(messageObject)).length;
    console.log(`Message size: ${messageSize} bytes`);
    
    if (messageSize > 256 * 1024) {
      console.warn("Warning: Message size exceeds SQS limit of 256KB");
      // Consider implementing S3 storage for oversized payloads
    }
    
    // Send to SQS
    const params = {
      QueueUrl: process.env.WEBHOOK_QUEUE_URL,
      MessageBody: JSON.stringify(messageObject),
    };
    let signature = '';
    // If using FIFO queue, add required FIFO parameters
    if (process.env.WEBHOOK_QUEUE_URL.endsWith(".fifo")) {
      // Generate a unique deduplication ID based on headers or use content-based deduplication
      if (process.env.NODE_ENV !== "development") {
        signature = parsedEvent.headers["X-Square-Signature"] || parsedEvent.headers["x-square-signature"];
      } else {
        signature = 'test';
      }
      const timestamp = new Date().getTime().toString();

      // Per-client MessageGroupId, derived from Square's merchant_id field
      // (present on every webhook event -- this is the same field
      // getSquareOrders already reads as clientId). A single shared group
      // for every client meant one stuck/failing message for ANY client
      // blocked delivery of every message behind it for EVERY client too,
      // since FIFO SQS strictly serializes delivery within a group
      // (confirmed empirically in a disposable sandbox test: messages in
      // *different* groups are delivered independently, so per-client
      // grouping genuinely isolates one client's processing failures from
      // every other client's orders). Falls back to a shared group only if
      // merchant_id can't be read, which keeps old behavior rather than
      // dropping the message outright.
      let merchantId = 'unknown-merchant';
      try {
        const bodyForRouting = typeof messageObject.body === 'string' ? JSON.parse(messageObject.body) : messageObject.body;
        merchantId = bodyForRouting?.merchant_id || merchantId;
      } catch (e) {
        console.warn('Could not parse merchant_id from webhook body for MessageGroupId; using fallback group', e);
      }

      // Add required FIFO parameters
      params.MessageGroupId = merchantId;

      // Optional: provide a deduplication ID if not using content-based deduplication
      params.MessageDeduplicationId = `${signature}-${timestamp}`;
    }
    
    
    // Send message to SQS
    const command = new SendMessageCommand(params);
    const result = await sqs.send(command);
    
    console.log("Successfully forwarded to SQS:", result.MessageId);
    
    // Return immediate 200 success to Square
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        message: "Webhook received",
        messageId: result.MessageId
      })
    };
  } catch (error) {
    console.error("Error forwarding to SQS:", error);
    
    // Still return 200 to Square to prevent retries, even if our processing failed
    // This ensures Square won't retry, but you should set up monitoring for these errors
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        message: "Webhook received, but processing error occurred",
        error: process.env.NODE_ENV === "development" ? error.message : "Internal error"
      })
    };
  }
};

