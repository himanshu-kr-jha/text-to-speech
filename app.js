if (process.env.NODE_ENV != "production") {
  require('dotenv').config()
}
const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const nodemailer = require('nodemailer');
const xlsx = require('xlsx'); // For handling Excel files
const winston = require('winston'); // Import winston for logging
// const path = require("path")

const app = express();
app.use(express.static(path.join(__dirname, "/public")));
const port = process.env.PORT || 3000;
app.use(express.json()); // Middleware to parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Middleware to parse form data
let fullfileContent;

// AWS S3 setup using environment variables
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});
function checkTextLimit(text) {
  const MAX_LENGTH = 3000;
  if (text.length > MAX_LENGTH) {
    console.log(`Text exceeds the limit of ${MAX_LENGTH} characters.`);
    return false;
  } else {
    console.log(`Text is within the limit of ${MAX_LENGTH} characters.`);
    return true;
  }
}

// Multer setup for file handling
const upload = multer({ dest: 'uploads/' });

// S3 Bucket names from environment variables
const sourceBucketName = process.env.SOURCE_BUCKET_NAME;
const destinationBucketName = process.env.DESTINATION_BUCKET_NAME;

// Email setup using Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail', // Gmail SMTP service
  auth: {
    user: process.env.EMAIL_USER, // Your email address
    pass: process.env.EMAIL_PASS, // Your email password or app-specific password
  },
});

// Store verification codes temporarily (you can use a more persistent solution in production)
let verificationCodes = {};

// Set EJS as the templating engine
app.set('view engine', 'ejs');

// Create a logger using winston
const logger = winston.createLogger({
  level: 'info', // Default level to log
  transports: [
    // Log to console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(), // Add color to console logs
        winston.format.simple() // Simple log format
      ),
    }),
    // Log to a file
    new winston.transports.File({
      filename: 'logs/app.log', // Log to a file
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json() // Log format as JSON
      ),
    }),
  ],
});

// Serve the 'frontend.ejs' file on the root route
app.get("/", (req, res) => {
  res.render("frontend");
});

app.get("/editor", (req, res) => {
  res.render("texteditor");
});

app.post('/submit-editor', upload.none(), async (req, res) => {
  const editorContent = req.body.content;  // Content from the editor

  if (!editorContent) {
    return res.status(400).send('No content received!');
  }

  // Generate a .txt file from the editor content
  const fileName = `editor-content-${Date.now()}.txt`;
  const filePath = path.join(__dirname, fileName);

  fs.writeFileSync(filePath, editorContent);  // Create the .txt file locally

  // Read the file into a buffer
  const fileBuffer = fs.readFileSync(filePath);

  // Set up parameters for S3 upload
  if (checkTextLimit(editorContent)) {
    const params = {
      Bucket: sourceBucketName,
      Key: `uploads/${fileName}`,
      Body: fileBuffer,
      ContentType: 'text/plain'
    };
    s3.upload(params, (err, data) => {
      // Delete the local file after uploading
      fs.unlinkSync(filePath);
  
      if (err) {
        console.error('Error uploading file:', err);
        return res.status(500).send('Error uploading file.');
      }
  
      // Return the S3 file URL in the response
      return res.json({ message: 'File uploaded successfully!', url: data.Location });
    });
  }
});
// Endpoint to handle file upload and save to S3
app.post('/upload', upload.single('file'), async (req, res) => {
   const filePath = req.file.path;

  try {
    // Dynamically set content type based on file extension
    const contentType = mime.lookup(req.file.originalname) || 'application/octet-stream';
    const fileContent = fs.readFileSync(filePath, 'utf-8'); // Read as UTF-8 string for human-readable text
    fullfileContent = fileContent;

    // Log the file upload process
    logger.info(`Processing file upload: ${req.file.originalname}`);
    if (checkTextLimit(fullfileContent)) {
      const uploadParams = {
        Bucket: sourceBucketName,
        Key: `uploads/${req.file.originalname}`, // File name in S3
        Body: fs.readFileSync(filePath), // Re-read the file to upload it
        ContentType: contentType,
      };

      const data = await s3.upload(uploadParams).promise();
      logger.info(`File uploaded successfully: ${data.Location}`);

      const fileNameWithoutExtension = path.parse(req.file.originalname).name; // Get the file name without extension
      res.json({
        message: 'File is being processed. Please wait...',
        fileName: fileNameWithoutExtension,
        contentPreview: fileContent.slice(0, 200),
      });
    } else {
      // Respond with an error message if the text exceeds the limit
      res.status(400).json({
        message: 'File content exceeds the maximum allowed character limit of 3000.',
        maxLength: 3000, // Include the maximum allowed length in the response
        currentLength: fullfileContent.length, // Include the current length of the file content
        suggestion: 'Please reduce the text size or split the content into smaller parts.'
      });
    }
  }
  catch (error) {
    logger.error(`Error uploading the file: ${error.message}`);
    res.status(500).send('Error uploading the file');
  } finally {
    // Clean up the file from local uploads folder (async)
    fs.promises.unlink(filePath).catch(err => logger.error(`Error cleaning up file: ${err.message}`));
  }


});

// Function to save email and file content to an Excel sheet
async function saveToExcel(email, fileContent) {
  const fileData = [{
    email: email,
    fileContent: fileContent
  }];

  // Create a new workbook and add data
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(fileData);
  xlsx.utils.book_append_sheet(wb, ws, "File Data");

  // Write the file content to an Excel file buffer
  const fileBuffer = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });

  // Upload to S3
  const params = {
    Bucket: process.env.excelBucket,
    Key: 'uploads_data.xlsx', // The desired file name in S3
    Body: fileBuffer,
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  try {
    const uploadResult = await s3.upload(params).promise();
    logger.info('Excel file uploaded to S3 successfully');
  } catch (error) {
    logger.error(`Error uploading Excel file: ${error.message}`);
  }
}

// Endpoint to send the verification code to the provided email
app.post('/sendVerificationCode', (req, res) => {
  const { email, fileName } = req.body;

  if (!email || !fileName) {
    return res.status(400).send('Email and file name are required');
  }

  const code = Math.floor(100000 + Math.random() * 900000); // 6-digit code
  verificationCodes[email] = { code, fileName };

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your Verification Code',
    text: `Your verification code is: ${code}`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      logger.error(`Error sending verification code: ${error.message}`);
      return res.status(500).send('Error sending verification code');
    }
    logger.info(`Verification code sent to ${email}: ${info.response}`);
    res.status(200).send('Verification code sent to email');
  });
});

// Endpoint to verify the code and get the audio URL
app.post('/verifyCode', async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).send('Email and code are required');
  }

  const storedCode = verificationCodes[email];

  if (!storedCode) {
    return res.status(400).send('No verification code sent for this email');
  }

  if (parseInt(code) === storedCode.code) {
    const fileName = storedCode.fileName;
    await saveToExcel(email, fullfileContent);  // Save to Excel
    res.json({ fileName });
  } else {
    logger.warn(`Invalid verification code attempt for ${email}`);
    res.status(400).send('Invalid verification code');
  }
});

// Endpoint to get the audio file from S3
app.get('/getAudio/:fileName', async (req, res) => {
  const { fileName } = req.params;

  if (!fileName) {
    return res.status(400).send('File name is required');
  }

  const audioFileName = `${fileName}.mp3`;
  const Key = `uploads/${audioFileName}`;

  try {
    const url = `https://${destinationBucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${Key}`;
    res.render("audio", { audioUrl: url, fileContent: fullfileContent });
  } catch (error) {
    logger.error(`Error fetching the audio file: ${error.message}`);
    res.status(500).send('Error fetching the audio file');
  }
});

app.listen(port, () => {
  logger.info(`Server is running at http://localhost:${port}`);
});
