CREATE DATABASE client_name;

-- Connect to the new client database
\c client_name

CREATE TABLE "QRCodeProduct" (
    "ID" SERIAL PRIMARY KEY,
    "QRCode" character varying(200) NOT NULL,
    "CheckedIn" boolean NOT NULL DEFAULT false,
    "CreatedDate" timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ExpirationDate" timestamp without time zone NOT NULL,
    "LastEditedDate" timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ProductMetadata" jsonb,
    "ProductDate" timestamp without time zone NOT NULL,
    "ProductName" character varying(420) NOT NULL,
    "ProductLocation" character varying(200) NOT NULL,
    "ProductType" character varying(200) NOT NULL,
    "ProductDetails" character varying(800) NOT NULL,
    "ProductPrice" NUMERIC(19, 4),
    "ProductID" character varying(100) not null,
    CONSTRAINT "idx_qrcodeproduct_qrcode" UNIQUE ("QRCode")
);

-- Create the Client table in each client database
CREATE TABLE "QRCodeProductToOrder" (
    "ID" SERIAL PRIMARY KEY,
    "QRCodeProductID" INT NOT NULL ,
    "OrderID" INT NOT NULL,
    "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Order" (
    "ID" SERIAL PRIMARY KEY,
    "OrderID" varchar(100) not null,
    "CreatedDate" timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "LastEditedDate" timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "OrderMetaData" jsonb,
    CONSTRAINT "idx_order_orderid" UNIQUE ("OrderID")
);

CREATE TABLE "Client" (
    "ID" SERIAL PRIMARY KEY,
    "ClientID" VARCHAR(100) NOT NULL UNIQUE,
    "ClientSecret" VARCHAR(100) NOT NULL,
    "ContactName" VARCHAR(255) NOT NULL,
    "ClientEmail" VARCHAR(255) NOT NULL,
    "Configuration" JSON,
/* Alters */
    "OrderID" VARCHAR(100) ,
    "ClientPlan" VARCHAR(255),
    "ClientMaxTicketsPerMonth" VARCHAR(255),
    "ClientChargePerTicket" NUMERIC(19, 4),
    "HasBeenSetup" bool ,
    "Status" varchar(255) ,
/* End of Alters */
    "SQUARE_ACCESS_TOKEN" VARCHAR(255),
    "SQUARE_SIGNATURE_KEY" VARCHAR(255),
    "SQUARE_WEBHOOK_URL" VARCHAR(255),
    "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create an index on clientID for faster lookups
CREATE INDEX idx_client_clientid ON "Client" ("clientID");

-- Sample insert of client credentials
INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail")
VALUES 
    ('YOUR_CLIENT_ID', 'client_secret_here', 'Contact Name', 'contact@example.com');


alter table "Client" ADD COLUMN "OrderID" VARCHAR(100),
ADD COLUMN "ClientPlan" VARCHAR(255), 
ADD COLUMN "ClientMaxTicketsPerMonth" VARCHAR(255),
ADD COLUMN "ClientChargePerTicket" NUMERIC(19, 4),
ADD COLUMN "HasBeenSetup" BOOLEAN, 
ADD COLUMN "Status" VARCHAR(255) ;
