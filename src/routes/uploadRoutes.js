import { Router } from "express";

import { upload } from "../middleware/multer.js";
import { verifySeller } from "../middleware/uploadAuth.js";

import { uploadController } from "../controllers/uploadController.js";

const router = Router();

/*
|--------------------------------------------------------------------------
| UPLOAD MULTIPLE IMAGES (standalone, no product created)
|--------------------------------------------------------------------------
|
| POST /upload/images
|
| Field name: images
|
*/

router.post(
  "/images",
  verifySeller,
  upload.array("images", 8),
  uploadController.images
);

/*
|--------------------------------------------------------------------------
| UPLOAD SINGLE IMAGE (standalone)
|--------------------------------------------------------------------------
|
| POST /upload/image
|
| Field name: image
|
*/

router.post(
  "/image",
  verifySeller,
  upload.single("image"),
  uploadController.image
);

/*
|--------------------------------------------------------------------------
| DELETE IMAGE
|--------------------------------------------------------------------------
|
| DELETE /upload/image  { publicId }
|
*/

router.delete(
  "/image",
  verifySeller,
  uploadController.removeImage
);

export default router;