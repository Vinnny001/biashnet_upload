// upload-server/src/middleware/uploadAuth.js

import axios from "axios";
import { AppError } from "../utils/errors.js";

const MAIN_API_URL =
  process.env.MAIN_API_URL || "http://localhost:5000/api";

const UPLOAD_API_KEY =
  process.env.UPLOAD_API_KEY;


/*
|--------------------------------------------------------------------------
| Verify seller with Main Biashnet Backend
|--------------------------------------------------------------------------
|
| Frontend sends:
|
| Authorization: Bearer <JWT>
|
| Upload server then sends BOTH:
|
| x-api-key: UPLOAD_API_KEY
| Authorization: Bearer <JWT>
|
| to the main Biashnet backend.
|
| The main backend decides whether the JWT is valid
| and whether the user is a seller.
|
|--------------------------------------------------------------------------
*/

export const verifySeller = async (req, res, next) => {

  try {

    /*
    |--------------------------------------------------------------------------
    | 1. Get JWT from frontend
    |--------------------------------------------------------------------------
    */

    const authorization =
      req.headers.authorization;


    if (
      !authorization ||
      !authorization.startsWith("Bearer ")
    ) {

      throw new AppError(
        "Unauthorized: missing authentication token",
        401
      );

    }


    const token =
      authorization.substring(7).trim();


    if (!token) {

      throw new AppError(
        "Unauthorized: invalid authentication token",
        401
      );

    }


    /*
    |--------------------------------------------------------------------------
    | 2. Make sure UPLOAD_API_KEY exists
    |--------------------------------------------------------------------------
    */

    if (!UPLOAD_API_KEY) {

      console.error(
        "❌ UPLOAD_API_KEY is not configured"
      );

      throw new AppError(
        "Upload server authentication is not configured",
        500
      );

    }


    /*
    |--------------------------------------------------------------------------
    | 3. Ask Main Biashnet Backend to verify the user
    |--------------------------------------------------------------------------
    */

    console.log(
      "🔐 Verifying seller with main Biashnet API..."
    );


    const response = await axios.get(
      `${MAIN_API_URL}/auth/verify-upload`,
      {
        headers: {

          Authorization:
            `Bearer ${token}`,

          "x-api-key":
            UPLOAD_API_KEY,

        },

        timeout: 10000,

      }
    );


    /*
    |--------------------------------------------------------------------------
    | 4. Main backend must confirm authorization
    |--------------------------------------------------------------------------
    */

    if (
      !response.data ||
      response.data.success !== true ||
      response.data.authorized !== true
    ) {

      throw new AppError(
        "Unauthorized: seller verification failed",
        403
      );

    }


    /*
    |--------------------------------------------------------------------------
    | 5. Save verified user information
    |--------------------------------------------------------------------------
    |
    | This information can be used later by the controller/service.
    |
    */

    req.user =
      response.data.user;


    console.log(
      "✅ Seller verified:",
      {
        id: req.user?.id,
        role: req.user?.role,
        email: req.user?.email,
      }
    );


    /*
    |--------------------------------------------------------------------------
    | 6. Continue to upload
    |--------------------------------------------------------------------------
    */

    next();

  } catch (error) {

    /*
    |--------------------------------------------------------------------------
    | Main backend rejected the authentication
    |--------------------------------------------------------------------------
    */

    if (error.response) {

      console.error(
        "❌ Main backend verification failed:",
        {
          status:
            error.response.status,

          data:
            error.response.data,
        }
      );


      return res.status(
        error.response.status === 401
          ? 401
          : 403
      ).json({

        success: false,

        error:
          error.response.data?.error ||
          "Unauthorized: seller verification failed",

      });

    }


    /*
    |--------------------------------------------------------------------------
    | Our own AppError
    |--------------------------------------------------------------------------
    */

    if (
      error instanceof AppError
    ) {

      return res.status(
        error.statusCode
      ).json({

        success: false,

        error:
          error.message,

      });

    }


    /*
    |--------------------------------------------------------------------------
    | Unexpected error
    |--------------------------------------------------------------------------
    */

    console.error(
      "❌ Upload authentication error:",
      error
    );


    return res.status(500).json({

      success: false,

      error:
        "Unable to verify authentication",

    });

  }

};
