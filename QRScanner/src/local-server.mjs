// local-server.mjs - For local development with ES Modules
import app from './app.mjs';

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Local development server running on http://localhost:${PORT}`);
  console.log('NODE_ENV:', process.env.NODE_ENV);
});