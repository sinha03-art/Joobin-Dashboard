const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: 'solomonchong2011@gmail.com, sinha03@gmail.com',
      subject: '📋 Test Email from Notion Webhook',
      html: '<h2>✅ Email notifications are working!</h2><p>This is a test email from your JOOBIN renovation system.</p>'
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Email sent!' })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};