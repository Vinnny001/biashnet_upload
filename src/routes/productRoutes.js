import { Router } from "express";

import { verifySeller } from "../middleware/uploadAuth.js";
import { upload } from "../middleware/multer.js";

import { productController } from "../controllers/productController.js";

const router = Router();

/*
|--------------------------------------------------------------------------
| CREATE PRODUCT
|--------------------------------------------------------------------------
|
| POST /upload/product
|
| ONE multipart/form-data request from frontend containing:
| - product fields
| - images[]
|
| Flow:
|
| Frontend
|    ↓
| Upload Server
|    ↓
| verifySeller (main API verifies JWT + seller)
|    ↓
| Multer receives images
|    ↓
| Cloudinary
|    ↓
| Firestore
|
*/

router.post(
  "/",
  verifySeller,
  upload.array("images", 8),
  productController.create
);

/*
|--------------------------------------------------------------------------
| GET PRODUCT
|--------------------------------------------------------------------------
|
| GET /upload/product/:id
|
*/

router.get(
  "/:id",
  productController.get
);

/*
|--------------------------------------------------------------------------
| DELETE PRODUCT
|--------------------------------------------------------------------------
|
| DELETE /upload/product/:id
|
*/

router.delete(
  "/:id",
  verifySeller,
  productController.remove
);


/*
|--------------------------------------------------------------------------
| UPDATE PRODUCT
|--------------------------------------------------------------------------
|
| PATCH /upload/product/:id
|
*/

router.patch(
  "/:id",
  verifySeller,
  upload.array("images", 8),
  productController.update
);


export default router;