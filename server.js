import "dotenv/config";

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import multer from "multer";

import uploadRoutes from "./src/routes/uploadRoutes.js";
import productRoutes from "./src/routes/productRoutes.js";

import { errorHandler } from "./src/utils/errors.js";


const app = express();


/* ==========================================================================
   CORS
   ========================================================================== */

const allowedOrigins =
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);


app.use(
  cors({
    origin: (origin, callback) => {

      // Allow server-to-server requests
      // because they don't have an Origin header.
      if (!origin) {
        return callback(null, true);
      }


      // If no origins are configured,
      // allow requests during local development.
      if (allowedOrigins.length === 0) {
        return callback(null, true);
      }


      // Allow configured frontend origins.
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }


      callback(
        new Error("Not allowed by CORS")
      );

    },
  })
);


/* ==========================================================================
   Rate limiting
   ========================================================================== */

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);


/* ==========================================================================
   Body parsing
   ========================================================================== */

app.use(express.json());


/* ==========================================================================
   Health check
   ========================================================================== */

app.get("/health", (req, res) => {

  res.json({
    success: true,
    status: "upload service running",
  });

});


/* ==========================================================================
   Image upload routes
   ========================================================================== */

app.use(
  "/upload",
  uploadRoutes
);


/* ==========================================================================
   Product routes
   ========================================================================== */

app.use(
  "/upload/product",
  productRoutes
);


/* ==========================================================================
   Multer errors
   ========================================================================== */

app.use(
  (err, req, res, next) => {

    if (err instanceof multer.MulterError) {

      return res.status(400).json({
        success: false,
        error: err.message,
      });

    }

    next(err);

  }
);


/* ==========================================================================
   Central error handler
   ========================================================================== */

app.use(errorHandler);


/* ==========================================================================
   Start server
   ========================================================================== */

const PORT =
  process.env.PORT || 5050;


console.log(
  "UPLOAD_API_KEY configured:",
  Boolean(process.env.UPLOAD_API_KEY)
);


if (process.env.MODE === "production") {
  console.log(
  "MAIN_API_URL:",
  process.env.MAIN_API_URL
);
}

else {
  console.log(
  "MAIN_API_URL:",
  process.env.LOCAL_API_URL
);
}



app.listen(
  PORT,
  () => {

    console.log(
      `Upload server running on port ${PORT}`
    );

  }
);