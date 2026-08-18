export const apiKeyAuth = (req, res, next) => {
  const expected = process.env.UPLOAD_API_KEY;

  // If no key is configured, skip (useful for local dev only)
  if (!expected) return next();

  const provided = req.headers["x-api-key"];

  if (provided !== expected) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized: invalid or missing API key"
    });
  }

  next();
};
