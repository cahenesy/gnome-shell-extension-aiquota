/**
 * Geometry for the popup menu's horizontal quota bar.
 *
 * Fill grows from the left edge of the *allocated* track. 100% occupies
 * that width exactly — never a centred block sized against a 200px
 * constant, which is what produced grey gutters on both sides.
 *
 * Pure, so the tests can drive it without a stage.
 *
 * @param {number} allocatedWidth  content-box width of the track, in px
 * @param {number|null|undefined} percent  0..100
 * @param {number} minSliver  minimum visible width when percent > 0
 * @returns {{fillX: number, fillWidth: number}}
 */
export function menuBarLayout(allocatedWidth, percent, minSliver = 0) {
    const track = Math.max(0, Math.round(Number(allocatedWidth) || 0));
    if (track <= 0)
        return {fillX: 0, fillWidth: 0};

    const p = typeof percent === 'number' && Number.isFinite(percent) ? percent : 0;
    if (p <= 0)
        return {fillX: 0, fillWidth: 0};

    if (p >= 100)
        return {fillX: 0, fillWidth: track};

    const sliver = Math.max(0, minSliver);
    const fillWidth = Math.min(track, Math.max(sliver, Math.round((track * p) / 100)));
    return {fillX: 0, fillWidth};
}
