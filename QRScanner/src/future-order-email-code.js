/*
S3_BUCKET_NAME=your-ticket-bucket
AWS_REGION=us-east-2  # or your region
*/
// Import required modules
import { SendRawEmailCommand } from "@aws-sdk/client-ses";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import mailcomposer from 'mailcomposer';
import { initializeModelForClient } from './models/Order.mjs'; // Adjust path as needed

// Initialize S3 client
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

// Your existing email sending function (you already have this)
async function sendEmailWithMultipleAttachments(sender, recipient, subject, body, attachments) {
  // Create a mail object
  const mail = mailcomposer({
    from: sender,
    to: recipient,
    subject: subject,
    text: body,
    attachments: attachments
  });

  // Build the MIME message
  const mimeMessage = await new Promise((resolve, reject) => {
    mail.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  // Send the raw email
  const result = await sesClient.send(new SendRawEmailCommand({
    RawMessage: { Data: mimeMessage }
  }));

  return result;
}

// New function to resend QR ticket email for an order
export async function resendOrderEmail(event, context) {
  try {
    console.log('Resend email request received:', JSON.stringify(event));
    
    // Extract orderId from path parameters
    const orderId = event.pathParameters?.orderId;
    if (!orderId) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: JSON.stringify({
          returnStatus: 'failed_missing_order_id',
          message: 'Order ID is required'
        })
      };
    }

    // Parse request body
    let requestBody = {};
    if (event.body) {
      try {
        requestBody = JSON.parse(event.body);
      } catch (e) {
        console.error('Error parsing request body:', e);
      }
    }

    // Extract JWT token and get client database info
    const authHeader = event.headers.Authorization || event.headers.authorization;
    if (!authHeader) {
      return {
        statusCode: 401,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: JSON.stringify({ message: 'No authorization header provided' })
      };
    }

    // Decode JWT to get client database name (adjust this based on your JWT structure)
    const token = authHeader.replace('Bearer ', '');
    const decodedToken = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const clientDbName = decodedToken.database || decodedToken.dbName; // Adjust field name as needed

    // Initialize database connection for client
    const { Order } = await initializeModelForClient(clientDbName);

    // Find the order by ID
    const order = await Order.findByPk(orderId);
    
    if (!order) {
      console.log('Order not found:', orderId);
      return {
        statusCode: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: JSON.stringify({
          returnStatus: 'failed_no_order',
          message: 'Order not found'
        })
      };
    }

    // Validate email address
    const emailAddress = order.emailAddress || requestBody.emailAddress;
    if (!emailAddress || !isValidEmail(emailAddress)) {
      console.log('Invalid email address:', emailAddress);
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: JSON.stringify({
          returnStatus: 'failed_invalid_email',
          message: 'Invalid email address'
        })
      };
    }

    // Prepare customer information
    const customerName = `${order.firstName || ''} ${order.lastName || ''}`.trim() || 'Valued Customer';
    const orderMetaData = order.orderMetaData || {};
    
    // Create email content
    const subject = `Your QR Code Ticket - Order ${order.orderID}`;
    const emailBody = createTicketEmailBody(order, customerName, orderMetaData);
    
    // Generate or retrieve QR code attachments
    // You'll need to adapt this based on how you generate QR codes
    const qrAttachments = await generateQRCodeAttachments(order, orderMetaData);
    
    // Send the email using your existing function
    const sender = process.env.SENDER_EMAIL || 'liberty.hall@gmail.com'; // Adjust as needed
    
    await sendEmailWithMultipleAttachments(
      sender,
      emailAddress,
      subject,
      emailBody,
      qrAttachments
    );

    console.log('Email resent successfully to:', emailAddress);
    
    // Update the LastEditedDate
    await order.update({
      lastEditedDate: new Date()
    });

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({
        returnStatus: 'successful_resend',
        message: 'Email resent successfully',
        emailAddress: emailAddress
      })
    };

  } catch (error) {
    console.error('Error resending email:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
      },
      body: JSON.stringify({
        returnStatus: 'failed_email_service',
        message: 'Failed to resend email',
        error: error.message
      })
    };
  }
}

// Helper function to validate email
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Helper function to create email body
function createTicketEmailBody(order, customerName, orderMetaData) {
  return `
Dear ${customerName},

Thank you for your order! Please find your QR code ticket(s) attached.

Order Details:
- Order ID: ${order.orderID}
- Created: ${order.createdDate}
- Customer: ${customerName}
- Email: ${order.emailAddress}
${orderMetaData.eventName ? `- Event: ${orderMetaData.eventName}` : ''}
${orderMetaData.ticketCount ? `- Number of Tickets: ${orderMetaData.ticketCount}` : ''}
${orderMetaData.totalAmount ? `- Total Amount: ${orderMetaData.totalAmount}` : ''}

Please save the attached QR code(s) to your phone or print them out to bring to the event.

For questions or concerns, please contact us.

Best regards,
Liberty Hall Team
`.trim();
}

// Helper function to generate QR code attachments by fetching from S3
async function generateQRCodeAttachments(order, orderMetaData) {
  try {
    console.log('Generating QR code attachments for order:', order.orderID);
    
    const attachments = [];
    const bucketName = process.env.S3_BUCKET_NAME || 'your-bucket-name'; // Adjust as needed
    
    // Method 1: If QR codes are stored in orderMetaData
    if (orderMetaData.qrCodes && Array.isArray(orderMetaData.qrCodes)) {
      for (let i = 0; i < orderMetaData.qrCodes.length; i++) {
        const qrCodeId = orderMetaData.qrCodes[i];
        
        try {
          // Fetch the ticket file from S3
          // Adjust the S3 key format based on how you store tickets
          const s3Key = `tickets/ticket-${qrCodeId}.pdf`; // Adjust path format as needed
          
          const fileContent = await getS3FileContent(bucketName, s3Key);
          
          attachments.push({
            filename: `ticket_${i + 1}_${order.orderID}.pdf`,
            content: fileContent,
            contentType: 'application/pdf'
          });
          
        } catch (s3Error) {
          console.error(`Error fetching QR code ${qrCodeId} from S3:`, s3Error);
          // Continue with other attachments even if one fails
        }
      }
    }
    
    // Method 2: If you need to look up QR codes from a related table
    // You might need to import and use your QRCodeProduct model here
    if (attachments.length === 0) {
      // Try to find related QR codes - adjust this query based on your data structure
      // Example: const { QRCodeProduct } = await initializeModelForClient(clientDbName);
      // const relatedQRCodes = await QRCodeProduct.findAll({ where: { /* your relation logic */ } });
      
      // For now, check if there's a single QR code reference in orderMetaData
      const qrCodeReference = orderMetaData.qrCode || orderMetaData.ticketId || order.orderID;
      
      if (qrCodeReference) {
        try {
          const s3Key = `tickets/ticket-${qrCodeReference}.pdf`; // Adjust format
          const fileContent = await getS3FileContent(bucketName, s3Key);
          
          attachments.push({
            filename: `ticket_${order.orderID}.pdf`,
            content: fileContent,
            contentType: 'application/pdf'
          });
          
        } catch (s3Error) {
          console.error(`Error fetching ticket for order ${order.orderID}:`, s3Error);
        }
      }
    }
    
    if (attachments.length === 0) {
      console.log('No QR code attachments found for order:', order.orderID);
      throw new Error('No ticket files found for this order');
    }
    
    console.log(`Generated ${attachments.length} attachments for order ${order.orderID}`);
    return attachments;
    
  } catch (error) {
    console.error('Error generating QR code attachments:', error);
    throw new Error('Failed to generate QR code attachments: ' + error.message);
  }
}

// Helper function to fetch file content from S3
async function getS3FileContent(bucketName, key) {
  try {
    console.log(`Fetching file from S3: ${bucketName}/${key}`);
    
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key
    });
    
    const response = await s3Client.send(command);
    
    // Convert the stream to a buffer
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    
    const fileBuffer = Buffer.concat(chunks);
    console.log(`Successfully fetched file: ${key}, size: ${fileBuffer.length} bytes`);
    
    return fileBuffer;
    
  } catch (error) {
    console.error(`Error fetching file from S3 (${bucketName}/${key}):`, error);
    throw error;
  }
}
