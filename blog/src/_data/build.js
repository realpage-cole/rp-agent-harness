// Build-time metadata. `new Date()` here is fine — it's the build machine clock,
// not the Eleventy template layer.
export default {
  year: new Date().getUTCFullYear(),
  timestamp: new Date().toISOString(),
};
