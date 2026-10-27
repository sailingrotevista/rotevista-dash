// Keep derived input deadlines on the client's clock without renewing age.
export function translateDerivedMeasurement(measurement, serverNow, localNow) {
  if (!measurement || !Number.isFinite(serverNow) || !Number.isFinite(localNow) ||
      !Number.isFinite(measurement.timestamp) || measurement.timestamp > serverNow ||
      !Number.isFinite(measurement.expiresAt)) return null;
  return {...measurement,
    timestamp:localNow-(serverNow-measurement.timestamp),
    expiresAt:localNow+(measurement.expiresAt-serverNow)};
}
export function derivedMeasurementValue(measurement, now) {
  return measurement?.valid === true && Number.isFinite(measurement.value) &&
    Number.isFinite(measurement.timestamp) && measurement.timestamp <= now &&
    Number.isFinite(measurement.expiresAt) && now < measurement.expiresAt ? measurement.value : null;
}
