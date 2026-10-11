// Camera facts every projection onto the framebuffer shares (walls, discs, voxel objects).

/** The camera (and every disc centre) sits at half wall height above the floor. */
export const EYE_HEIGHT = 0.5;
/** Nearer than this (tiles, along the view direction) nothing is drawn. */
export const MIN_DEPTH = 0.1;
