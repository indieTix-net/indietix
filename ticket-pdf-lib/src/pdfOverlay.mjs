import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// Faithful port of getSquareOrders/src/index.mjs's old overlayQRCodeOnPdf --
// same layout math, same text-wrapping behavior, same both-orientation
// logic. The one real difference: orientation is a plain parameter here
// instead of being read from a client's config object, since this
// library has no notion of "a client" at all -- callers resolve that
// before calling in.
//
// getSquareOrders now calls this directly (migrated 2026-10-25, after
// this was proven out via QRScanner's ticket-transfer feature first).

/**
 * @param {Buffer} templatePdfBuffer - the blank ticket template PDF
 * @param {Buffer} qrCodeBuffer - a QR code PNG (see generateQRCode)
 * @param {{name: string, variation?: string, itemModifierValues?: string}} orderInfo
 * @param {'horizontal'|'vertical'} [orientation='horizontal']
 * @returns {Promise<Uint8Array>} the rendered PDF's bytes
 */
export async function renderTicketPdf(templatePdfBuffer, qrCodeBuffer, orderInfo, orientation = 'horizontal') {
  const pdfDoc = await PDFDocument.load(templatePdfBuffer);
  const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const firstPage = pdfDoc.getPages()[0];

  const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
  const { width, height } = firstPage.getSize();

  const qrSize = 120;

  let qrCodeX, qrCodeY, textX, textY, maxTextWidth, maxTextHeight;

  if (orientation === 'vertical') {
    // Vertical layout (600w x 1800h)
    // QR code at top center, 50px from top
    qrCodeX = (width - qrSize) / 2;
    qrCodeY = height - 75 - (0.5) * qrSize;

    // Text area below QR code, centered
    textX = 25; // 50px margin from left
    maxTextWidth = width - 50; // 50px margins on both sides

    // Text starts below QR code with some padding
    textY = qrCodeY - 30;

    // Text should not go further than 70% down the ticket height
    const maxTextBottom = height * 0.3; // 30% from bottom = 70% from top
    maxTextHeight = textY - maxTextBottom;

  } else {
    // Horizontal layout (1800w x 600h) - existing logic
    qrCodeX = width - 130;
    qrCodeY = (height / 2) - 60;

    textX = width - 275;
    maxTextWidth = qrCodeX - textX - 10; // 10px padding
    maxTextHeight = height; // No height restriction for horizontal
    textY = null; // Will be calculated based on content for centering
  }

  // Draw QR code
  firstPage.drawImage(qrImage, {
    x: qrCodeX,
    y: qrCodeY,
    width: qrSize,
    height: qrSize,
  });

  // Text parameters
  const lineHeight = 10;
  const fontSize = 8;

  // Function to calculate text height based on content and width constraints
  function calculateTextHeight(text, maxWidth, font, fontSize) {
    if (!text) return 0;

    const words = text.split(' ');
    let line = '';
    let lineCount = 1;

    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const textWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (textWidth > maxWidth && line) {
        line = word;
        lineCount++;
      } else {
        line = testLine;
      }
    }

    return lineCount * lineHeight;
  }

  // Function to handle text wrapping with height constraints
  function drawWrappedText(text, x, y, maxWidth, maxHeight, lineHeight, font, fontSize) {
    if (!text) return y;

    const words = text.split(' ');
    let line = '';
    let currentY = y;
    let linesDrawn = 0;
    const maxLines = maxHeight ? Math.floor(maxHeight / lineHeight) : Infinity;

    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const textWidth = font.widthOfTextAtSize(testLine, fontSize);

      if (textWidth > maxWidth && line) {
        // Check if we have room for another line
        if (linesDrawn >= maxLines - 1) {
          // Truncate text if we're out of space
          const truncatedLine = line + '...';
          firstPage.drawText(truncatedLine, {
            x,
            y: currentY,
            size: fontSize,
            font,
            color: rgb(0, 0, 0),
          });
          return currentY - lineHeight;
        }

        // Draw completed line and move to next line
        firstPage.drawText(line, {
          x,
          y: currentY,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });

        line = word;
        currentY -= lineHeight;
        linesDrawn++;
      } else {
        line = testLine;
      }
    }

    // Draw the last line if we have space
    if (line && linesDrawn < maxLines) {
      firstPage.drawText(line, {
        x,
        y: currentY,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }

    return currentY - lineHeight; // Return the Y position for the next text block
  }

  if (orientation === 'vertical') {
    // Vertical layout text positioning
    let currentY = textY;
    const spacingBetweenSections = lineHeight / 2;

    // Draw title
    firstPage.drawText('TICKET INFORMATION:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    currentY -= lineHeight + spacingBetweenSections;

    // Draw item name
    firstPage.drawText('Event:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    currentY -= lineHeight;

    // Draw name with wrapping and height constraints
    currentY = drawWrappedText(
      orderInfo.name,
      textX + 10,
      currentY,
      maxTextWidth - 10,
      maxTextHeight * 0.4, // Use 40% of available height for event name
      lineHeight,
      helveticaFont,
      fontSize
    );

    // Draw variation if available and we have space
    if (orderInfo.variation && currentY > (height * 0.3 + lineHeight * 3)) {
      currentY -= spacingBetweenSections;

      firstPage.drawText('Details:', {
        x: textX,
        y: currentY,
        size: fontSize,
        font: helveticaBold,
        color: rgb(0, 0, 0),
      });

      currentY -= lineHeight;

      // Use remaining height for details
      const remainingHeight = currentY - (height * 0.3);
      drawWrappedText(
        orderInfo.variation + ': ' + orderInfo.itemModifierValues,
        textX + 10,
        currentY,
        maxTextWidth - 10,
        remainingHeight,
        lineHeight,
        helveticaFont,
        fontSize
      );
    }

  } else {
    // Horizontal layout text positioning (existing logic with minor adjustments)
    // Calculate total text height to center vertically
    const titleHeight = lineHeight;
    const nameHeight = calculateTextHeight(orderInfo.name, maxTextWidth - 25, helveticaFont, fontSize);
    const variationHeight = orderInfo.variation ?
      calculateTextHeight(orderInfo.variation, maxTextWidth - 35, helveticaFont, fontSize) : 0;

    // Add spacing between sections
    const spacingBetweenSections = lineHeight / 2;
    const totalTextHeight = titleHeight + nameHeight +
      (orderInfo.variation ? variationHeight + spacingBetweenSections : 0);

    // Center text block vertically relative to QR code
    const qrCodeCenterY = qrCodeY + qrSize / 2;
    const startY = qrCodeCenterY + totalTextHeight / 2;

    // Draw title
    let currentY = startY;
    firstPage.drawText('TICKET INFORMATION:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    currentY -= lineHeight;

    // Draw item name with wrapping
    firstPage.drawText('Event:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    // Draw name with offset for "Event:" label
    currentY = drawWrappedText(
      orderInfo.name,
      textX + 35,
      currentY,
      maxTextWidth - 25,
      null, // No height constraint for horizontal layout
      lineHeight,
      helveticaFont,
      fontSize
    );

    // Draw variation if available
    if (orderInfo.variation) {
      currentY -= spacingBetweenSections; // Add spacing between sections

      firstPage.drawText('Details:', {
        x: textX,
        y: currentY,
        size: fontSize,
        font: helveticaBold,
        color: rgb(0, 0, 0),
      });

      // Draw variation with offset for "Details:" label
      drawWrappedText(
        orderInfo.variation + ': ' + orderInfo.itemModifierValues,
        textX + 35,
        currentY,
        maxTextWidth - 35,
        null, // No height constraint for horizontal layout
        lineHeight,
        helveticaFont,
        fontSize
      );
    }
  }

  return await pdfDoc.save();
}
