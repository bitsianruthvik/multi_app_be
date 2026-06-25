/**
 * Version Control Middleware
 * Handles API versioning, validation, and feature flags
 */

import {
  SUPPORTED_VERSIONS,
  DEFAULT_VERSION,
  VERSION_DEPRECATION,
  VERSION_FEATURES,
} from "../../config/versions.js";

/**
 * Validates API version and attaches version-specific features to request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export function versionControl(req, res, next) {
  // Extract version from URL (e.g., /api/v1/resource)
  const versionMatch = req.path.match(/\/v(\d+)\//);
  const requestedVersion = versionMatch
    ? `v${versionMatch[1]}`
    : DEFAULT_VERSION;

  // Check if version is supported
  if (!SUPPORTED_VERSIONS.includes(requestedVersion)) {
    return res.status(400).json({
      error: "Unsupported API version",
      message: `Supported versions are: ${SUPPORTED_VERSIONS.join(", ")}`,
      currentVersion: requestedVersion,
    });
  }

  // Check if version is deprecated
  const deprecationDate = VERSION_DEPRECATION[requestedVersion];
  if (deprecationDate && new Date(deprecationDate) <= new Date()) {
    return res.status(410).json({
      error: "API version deprecated",
      message: `Version ${requestedVersion} was deprecated on ${deprecationDate}`,
      suggestedVersion: SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1],
    });
  }

  // Get version-specific features and attach to request
  const versionFeatures = VERSION_FEATURES[requestedVersion];

  // Attach version info to request object for use in routes
  req.apiVersion = {
    version: requestedVersion,
    features: versionFeatures,
    // Helper methods for feature checking
    supports: (feature) => {
      return versionFeatures[feature]?.enabled === true;
    },
    supportsResource: (resource) => {
      return versionFeatures.resources.supported.includes(resource);
    },
    getFeatureConfig: (feature) => {
      return versionFeatures[feature] || null;
    },
  };

  // Add deprecation warning header if version will be deprecated soon
  if (deprecationDate) {
    const sixMonthsFromNow = new Date();
    sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);

    if (new Date(deprecationDate) <= sixMonthsFromNow) {
      res.set(
        "X-API-Warn",
        `Version ${requestedVersion} will be deprecated on ${deprecationDate}`
      );
    }
  }

  next();
}
