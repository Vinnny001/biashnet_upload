import {
  productService,
} from "../services/productService.js";

import {
  uploadService,
} from "../services/uploadService.js";

import {
  asyncHandler,
  AppError,
} from "../utils/errors.js";


export const productController = {


  /*
  |--------------------------------------------------------------------------
  | CREATE PRODUCT
  |--------------------------------------------------------------------------
  |
  | POST /upload/product
  |
  | Authentication has already been handled by verifySeller middleware.
  | Multer has already parsed multipart/form-data:
  |   - req.body  -> product fields (all strings)
  |   - req.files -> uploaded image files (field name: images)
  |
  */

  create: asyncHandler(
    async (req, res) => {

      const actor =
        req.user;

      if (!actor) {
        throw new AppError(
          "Unauthorized: seller information is missing.",
          401
        );
      }

      const files =
        req.files || [];

      if (!files.length) {
        throw new AppError(
          "At least one product image is required.",
          400
        );
      }

      const uploadResult =
        await uploadService.uploadImages(
          files,
          "biashnet/products"
        );

      const uploadedImages =
        uploadResult?.images || [];

      if (uploadedImages.length !== files.length) {
        throw new AppError(
          "One or more images failed to upload.",
          502
        );
      }

      let existingImages = [];

      if (req.body.existingImages) {
        try {
          existingImages =
            JSON.parse(req.body.existingImages);
        } catch {
          existingImages = [];
        }
      }

      const data = {
        ...req.body,
        images: [
          ...existingImages,
          ...uploadedImages,
        ],
      };

      delete data.existingImages;

      const product =
        await productService.create(
          data,
          actor
        );

      res.status(201).json({
        success: true,
        data: product,
      });

    }
  ),


  /*
  |--------------------------------------------------------------------------
  | GET PRODUCT
  |--------------------------------------------------------------------------
  */

  get: asyncHandler(
    async (req, res) => {

      const product =
        await productService.findById(
          req.params.id
        );

      if (!product) {
        throw new AppError(
          "Product not found.",
          404
        );
      }

      res.json({
        success: true,
        data: product,
      });

    }
  ),


  /*
  |--------------------------------------------------------------------------
  | UPDATE PRODUCT
  |--------------------------------------------------------------------------
  |
  | PATCH /upload/product/:id
  |
  | Ownership is enforced in productService.update, not here — the
  | controller only handles image merging, same as create().
  |
  */

  update: asyncHandler(
    async (req, res) => {

      const actor =
        req.user;

      if (!actor) {
        throw new AppError(
          "Unauthorized: seller information is missing.",
          401
        );
      }

      const files =
        req.files || [];

      let uploadedImages = [];

      if (files.length) {

        const uploadResult =
          await uploadService.uploadImages(
            files,
            "biashnet/products"
          );

        uploadedImages =
          uploadResult?.images || [];

        if (uploadedImages.length !== files.length) {
          throw new AppError(
            "One or more images failed to upload.",
            502
          );
        }

      }

      let existingImages = [];

      if (req.body.existingImages) {
        try {
          existingImages =
            JSON.parse(req.body.existingImages);
        } catch {
          existingImages = [];
        }
      }

      const data = {
        ...req.body,
      };

      if (req.body.existingImages || uploadedImages.length) {
        data.images = [
          ...existingImages,
          ...uploadedImages,
        ];
      }

      delete data.existingImages;

      const product =
        await productService.update(
          req.params.id,
          data,
          actor
        );

      res.json({
        success: true,
        data: product,
      });

    }
  ),


  /*
  |--------------------------------------------------------------------------
  | DELETE PRODUCT
  |--------------------------------------------------------------------------
  */

  remove: asyncHandler(
    async (req, res) => {

      const result =
        await productService.remove(
          req.params.id
        );

      res.json({
        success: true,
        data: result,
      });

    }
  ),

};