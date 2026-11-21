/*
 * Working units: lengths are shown and typed in centimetres. The model itself is in metres.
 * Typed values may name another unit: "2.5m", "25mm", "250cm" (a bare number is cm).
 */

const PER_METRE = { mm: 1000, cm: 100, m: 1 };

/** Centimetres as a short number: 250, 12.5 (at most one decimal). */
export const cm = (metres) => +(metres * 100).toFixed(1);

/** A length for labels: "250 cm". */
export const formatLength = (metres) => `${cm(metres)} cm`;

/** An area for labels, in m² (cm² would give huge numbers for floors): "8.37 m²". */
export const formatArea = (m2) => `${m2.toFixed(2)} m²`;

/** A typed length → metres (NaN if it isn't one). "250" = 250 cm; "2.5m", "25 mm" also work. */
export function parseLength(text) {
  const m = String(text).trim().replace(',', '.').match(/^(-?\d*\.?\d+)\s*(mm|cm|m)?$/i);
  if (!m) return NaN;
  return parseFloat(m[1]) / PER_METRE[(m[2] || 'cm').toLowerCase()];
}
