// Hall geometry in real-world metres. The same numbers drive the 2D seat map
// and the 3D view, so what you click is exactly where the camera is placed.
//
// Coordinate system: the screen sits on the plane z = 0 and faces +z.
// Seats are at positive z, x is left/right (negative = left as seen by the
// audience), y is up.

export const HALL = {
  name: 'Αίθουσα 4 · Laser',
  screen: { width: 14, aspect: 2.39, bottom: 1.4 },  // scope screen, 14 m wide
  firstRowDist: 5.2,   // metres from screen to row A
  rowDepth: 1.05,      // seat-to-seat distance front/back
  rise: 0.34,          // stadium step height per row
  seatWidth: 0.58,
  aisle: 1.1,          // width of each aisle between blocks
  curvature: 0.006,    // rows bend gently towards the screen
  eyeHeight: 1.15,     // seated eye height above the step
  rows: [
    { id: 'A', blocks: [4, 10, 4], wheel: [0, 17] },
    { id: 'B', blocks: [5, 10, 5] },
    { id: 'C', blocks: [5, 12, 5] },
    { id: 'D', blocks: [6, 12, 6] },
    { id: 'E', blocks: [6, 12, 6] },
    { id: 'F', blocks: [6, 12, 6] },
    { id: 'G', blocks: [6, 12, 6] },
    { id: 'H', blocks: [6, 12, 6] },
    { id: 'I', blocks: [6, 12, 6] },
    { id: 'J', blocks: [6, 12, 6] },
    { id: 'K', blocks: [5, 10, 5], vip: true },
    { id: 'L', blocks: [5, 10, 5], vip: true },
  ],
};

export const PRICES = { standard: 8.5, vip: 12, wheel: 8.5 };

HALL.screen.height = HALL.screen.width / HALL.screen.aspect;
HALL.screen.centerY = HALL.screen.bottom + HALL.screen.height / 2;

/** Build the flat list of seats with positions. */
export function buildSeats(hall = HALL) {
  const seats = [];
  hall.rows.forEach((row, r) => {
    const count = row.blocks.reduce((a, b) => a + b, 0);
    const total = count * hall.seatWidth + (row.blocks.length - 1) * hall.aisle;
    let x = -total / 2 + hall.seatWidth / 2;
    let n = 0;
    row.blocks.forEach((size, b) => {
      for (let i = 0; i < size; i++) {
        const z = hall.firstRowDist + r * hall.rowDepth + hall.curvature * x * x;
        const type = row.wheel?.includes(n) ? 'wheel' : row.vip ? 'vip' : 'standard';
        seats.push({
          id: `${row.id}${n + 1}`,
          row: row.id, rowIndex: r, number: n + 1, index: n, count,
          x, z, floorY: r * hall.rise, type,
          // seats face perpendicular to the (curved) row, like in a real hall
          facing: Math.atan(2 * hall.curvature * x),
        });
        x += hall.seatWidth;
        n++;
      }
      if (b < row.blocks.length - 1) x += hall.aisle;
    });
  });
  return seats;
}

/** Eye position of a person sitting in the seat. */
export function eyePosition(seat, hall = HALL) {
  return { x: seat.x, y: seat.floorY + hall.eyeHeight, z: seat.z };
}

/**
 * Viewing metrics for a seat, based on common cinema-design guidelines:
 *  - Horizontal viewing angle (how much of your field of view the screen fills).
 *    SMPTE recommends ≥30°, THX ~36–40°, "immersive" up to ~50°.
 *  - Off-axis angle from the screen centre (lower is better, >25° distorts).
 *  - Vertical angle up to the top of the screen (neck comfort, ideally <30–35°).
 */
export function seatMetrics(seat, hall = HALL) {
  const eye = eyePosition(seat, hall);
  const s = hall.screen;
  const d = Math.hypot(eye.x, eye.z);
  const left = Math.atan2(-s.width / 2 - eye.x, eye.z);
  const right = Math.atan2(s.width / 2 - eye.x, eye.z);
  const hAngle = deg(right - left);
  const offAxis = deg(Math.abs(Math.atan2(eye.x, eye.z)));
  const topAngle = deg(Math.atan2(s.bottom + s.height - eye.y, eye.z));
  const centerAngle = deg(Math.atan2(s.centerY - eye.y, eye.z));

  // 0–100 score: peak at ~40° horizontal angle, penalties for off-axis and neck tilt.
  let score = 100;
  score -= Math.max(0, Math.abs(hAngle - 40) - 4) * 2.2;
  score -= Math.max(0, offAxis - 8) * 2.0;
  score -= Math.max(0, topAngle - 30) * 2.5;
  score = Math.round(Math.max(5, Math.min(100, score)));

  let label, tone;
  if (score >= 85) { label = 'Ιδανική θέα'; tone = 'good'; }
  else if (score >= 65) { label = 'Πολύ καλή θέα'; tone = 'good'; }
  else if (score >= 45) { label = hAngle > 55 ? 'Αρκετά κοντά' : offAxis > 20 ? 'Πλάγια οπτική' : 'Καλή θέα'; tone = 'ok'; }
  else { label = hAngle > 55 ? 'Πολύ κοντά στην οθόνη' : offAxis > 20 ? 'Πολύ πλάγια' : 'Μακριά'; tone = 'bad'; }

  return { distance: d, hAngle, offAxis, topAngle, centerAngle, score, label, tone };
}

function deg(r) { return (r * 180) / Math.PI; }
