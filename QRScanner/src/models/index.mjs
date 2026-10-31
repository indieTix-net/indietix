// models/index.mjs
import { sequelize, QRCodeProduct, initializeModelForClient, Sequelize } from './product.mjs';

// Re-export everything from product.mjs
export { sequelize, QRCodeProduct, initializeModelForClient, Sequelize };

// Default export for compatibility with both import styles
export default {
  sequelize,
  QRCodeProduct,
  initializeModelForClient,
  Sequelize
};

