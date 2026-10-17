// The landing page's title picture: one still frame from the room's own renderer. Max sneaks a beer behind a
// corner while Ada and Bob talk down the corridor. Faces are 16×16 pixel art scaled into the FACE_SIZE² texture
// a camera face would fill, so the sprite pass draws them like any avatar.
import { type GameMap, type HeldItem, type PlayerState, parseMap } from '@zoom3d/shared';
import { FACE_SIZE } from '../media/faces';
import type { Framebuffer } from '../renderer/framebuffer';
import { bakeLighting, LAMP, type Light, type Lighting } from '../renderer/lighting';
import { hexToRgb, type PeopleAndObjects, renderSprites, type Sprite } from '../renderer/sprites';
import { makeTextures } from '../renderer/textures';
import type { VoxelInstance } from '../renderer/voxels';
import { CEILING, FLOOR, type Room, renderWalls } from '../renderer/walls';
import { drawLogo } from './landing-logo';

export const LANDING_MAP: GameMap = parseMap(`
3333333333333333
3333333333333333
333..33333333333
3..............3
3S.............3
3..............3
3333333333333333
`);

export const LANDING_CAMERA: PlayerState = { x: 1.2, y: 4.8, angle: -0.4 };
/** A portrait phone's narrower view (mobile spec §3): backed into the corner, so Max, Ada and Bob all still fit. */
export const LANDING_CAMERA_PORTRAIT: PlayerState = { x: 1.05, y: 4.9, angle: -0.36 };

/** SPIKE: two ceiling lamps down the corridor; Max's alcove stays in the dark. */
export const LANDING_LIGHTS: readonly Light[] = [
  { x: 5.5, y: 4.5, z: 0.85, radius: 4.5, ...LAMP },
  { x: 11, y: 4.5, z: 0.85, radius: 4.5, ...LAMP },
];
export const AMBIENT = 0.45;
let landingLighting: Lighting | null = null;

/** The camera for this frame's shape. */
export function landingCamera(fb: Framebuffer): PlayerState {
  return fb.width < fb.height ? LANDING_CAMERA_PORTRAIT : LANDING_CAMERA;
}

export const FACE_GRID = 16;
/**
 * The title's distance from the top and from the right, in framebuffer pixels. The panel keeps the same inset from
 * the bottom-right corner (index.html: 28 / 640 = 4.375% of the stage width).
 */
const LOGO_MARGIN = 28;

/** Shared face colours; a person can override any of them (hair, beard). */
export const FACE_PALETTE = {
  k: '#1a1410', // outline
  h: '#5a3418', // hair
  b: '#3a2410', // brows, beard
  s: '#e8b48a', // skin
  S: '#c48a64', // skin shadow
  w: '#ffffff', // eye white
  e: '#1a1410', // pupil
  m: '#7a2a2a', // mouth
};

type FaceColour = keyof typeof FACE_PALETTE;

export interface LandingPerson {
  name: string;
  color: string;
  x: number;
  y: number;
  /** FACE_GRID rows of FACE_PALETTE letters; '.' is the person's colour. */
  face: readonly string[];
  colors?: Partial<Record<FaceColour, string>>;
  held?: HeldItem;
  sip?: number;
  speaking?: number;
}

export const LANDING_PEOPLE: readonly LandingPerson[] = [
  {
    name: 'Max',
    color: '#f58231',
    // As close to the near wall as the camera allows without cutting the disc, and out of Ada and Bob's sight.
    x: 4.06,
    y: 2.44,
    held: 'beer',
    sip: 0.7,
    // Glancing towards the corridor.
    face: [
      '................',
      '.....kkkkkk.....',
      '...kkhhhhhhkk...',
      '..khhhhhhhhhhk..',
      '..khhhhhhhhhhk..',
      '..khssssssshhk..',
      '..kssssssssssk..',
      '..ksbbssssbbsk..',
      '..kswessssweSk..',
      '.kSssssssssssSk.',
      '..ksssssSsssSk..',
      '..ksssssssssSk..',
      '..kssssmmmssSk..',
      '...kssssssSSk...',
      '....kkSSSSkk....',
      '......kkkk......',
    ],
  },
  {
    name: 'Ada',
    color: '#e6194b',
    x: 8.46,
    y: 4.24,
    speaking: 1,
    colors: { h: '#2a1a1a', b: '#2a1a1a' },
    // Talking, looking at Bob.
    face: [
      '.....kkkkkk.....',
      '...kkhhhhhhkk...',
      '..khhhhhhhhhhk..',
      '.khhhhhhhhhhhhk.',
      '.khhssssssssshk.',
      '.khssssssssssshk',
      '.khsbbssssbbsshk',
      '.khswessssweSshk',
      '.khssssssssssshk',
      '.khsssssSssssshk',
      '.khssssssssssshk',
      '.khhssskkkssshhk',
      '.khhssskmkssshhk',
      '.khhhssskssshhhk',
      '..khhhSSSSShhhk.',
      '..khhkkkkkkkhhk.',
    ],
  },
  {
    name: 'Bob',
    color: '#3cb44b',
    x: 8.8,
    y: 5.05,
    colors: { h: '#8a6a3a', b: '#8a6a3a' },
    // Bearded, listening to Ada.
    face: [
      '................',
      '.....kkkkkk.....',
      '....khhhhhhk....',
      '...khhhhhhhhk...',
      '..khsssssssshk..',
      '..kssssssssssk..',
      '..ksbbbssbbbsk..',
      '..ksewssssewsk..',
      '.kSssssssssssSk.',
      '..ksssssSssssk..',
      '..kbssssssssbk..',
      '..kbbbmmmmbbbk..',
      '..kbbbbbbbbbbk..',
      '...kbbbbbbbbk...',
      '....kbbbbbbk....',
      '.....kkkkkk.....',
    ],
  },
];

/** The person's face grid scaled up to FACE_SIZE² texels. */
export function faceTexels(person: LandingPerson): Uint32Array {
  const palette: Record<string, number> = { '.': hexToRgb(person.color) };
  for (const [ch, hex] of Object.entries({ ...FACE_PALETTE, ...person.colors })) {
    palette[ch] = hexToRgb(hex);
  }
  const cell = FACE_SIZE / FACE_GRID;
  const texels = new Uint32Array(FACE_SIZE * FACE_SIZE);
  for (let y = 0; y < FACE_SIZE; y++) {
    const row = person.face.at(Math.floor(y / cell)) ?? '';
    for (let x = 0; x < FACE_SIZE; x++) {
      texels[y * FACE_SIZE + x] = palette[row.charAt(Math.floor(x / cell))] ?? 0;
    }
  }
  return texels;
}

/** The picture as the renderer takes it, built on first use and reused: the landing show redraws it every frame. */
let landingRoom: (Room & PeopleAndObjects & { objects: VoxelInstance[] }) | null = null;

function landingSprites(): Sprite[] {
  return LANDING_PEOPLE.map((p, i) => ({
    key: String(i),
    x: p.x,
    y: p.y,
    color: hexToRgb(p.color),
    face: faceTexels(p),
    speaking: p.speaking ?? 0,
    bob: 0,
    itemBob: 0,
    sip: p.sip ?? 0,
    cheers: 0,
    wobble: 0,
    held: p.held ?? null,
    boombox: false,
  }));
}

/**
 * Draws the picture into `fb`: the landing page shows it with the title, and the lobby without, until Join starts
 * the room. `vacuum` is the landing show's robot (landing vacuum spec §3.3), drawn among the people.
 */
export function renderLandingScene(
  fb: Framebuffer,
  {
    logo = true,
    lights = false,
    vacuum = null,
  }: { logo?: boolean; lights?: boolean; vacuum?: VoxelInstance | null } = {}
): void {
  const camera = landingCamera(fb);
  if (lights && !landingLighting) {
    landingLighting = bakeLighting(LANDING_MAP, LANDING_LIGHTS, AMBIENT, FLOOR, CEILING);
  }
  landingRoom ??= {
    map: LANDING_MAP,
    textures: makeTextures(1),
    eye: camera,
    lighting: null,
    people: landingSprites(),
    objects: [],
  };
  landingRoom.eye = camera;
  landingRoom.lighting = lights ? landingLighting : null;
  landingRoom.objects.length = 0;
  if (vacuum) {
    landingRoom.objects.push(vacuum);
  }
  renderWalls(fb, landingRoom);
  renderSprites(fb, landingRoom);
  if (logo) {
    drawLogo(fb, LOGO_MARGIN, camera === LANDING_CAMERA_PORTRAIT ? 'center' : 'right');
  }
}
