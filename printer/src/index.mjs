// Local print agent. Runs once on the venue's LAN (any one machine, or a
// small dedicated box) -- NOT per-computer. Every till's browser calls
// this same instance over the LAN (by its local IP, not "localhost") to
// print a ticket to the one shared, network-connected Brother QL-820NWB.
//
// Deliberately NOT exposed to the internet. This has no auth of its own
// -- it trusts anything that can reach it on the LAN, same trust model
// as a shared office network printer. Don't port-forward this.
import express from 'express';
import cors from 'cors';
import { PORT } from './config.mjs';
import { printTicket, previewTicket } from './printTicket.mjs';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/print', async (req, res) => {
  const { pdfUrl } = req.body;
  if (!pdfUrl) {
    return res.status(400).json({ success: false, message: 'pdfUrl is required' });
  }

  try {
    await printTicket(pdfUrl);
    res.json({ success: true });
  } catch (error) {
    console.error('Print failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Not used by the real "Print Ticket" button -- for verifying layout
// against a known-good PDF before the printer is physically in hand, or
// for debugging a bad print without burning a label. Returns a PNG.
app.post('/preview', async (req, res) => {
  const { pdfUrl } = req.body;
  if (!pdfUrl) {
    return res.status(400).json({ success: false, message: 'pdfUrl is required' });
  }

  try {
    const png = await previewTicket(pdfUrl);
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (error) {
    console.error('Preview failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Print agent listening on port ${PORT}`);
});
