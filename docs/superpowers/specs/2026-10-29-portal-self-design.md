# Seeing yourself through a portal

Date: 2026-10-29. Status: draft for review. A small change; it closes a known gap in D27 ("a player never sees
themselves through a portal loop").

## Intent

With portals on, a window shows the room beyond a doorway from the eye carried through it. When that view looks back
at the spot where the local player stands, it shows the spot empty, as if they weren't there. The user wants a player
to be able to see themselves through a portal, exactly as others see them.

## What it does

- **The local player's own avatar is drawn in window views only:**
  - their face disc with their live face (or ring colour), ring and speaking glow;
  - what they hold (a drink or a boombox);
  - their walking bob;
  - their name label.

  It stands at their real position, so it appears wherever a window looks back at where they stand, at any window
  level.
- **The direct view (the main pass) never draws it,** as today.
- Everything the window views already do for other people applies to it as well:
  - the cut at the doorway's plane;
  - depth against walls;
  - the dark during a portal switch (D30);
  - a label shown at the doorway it is seen through.
- **Discs always turn to the viewer,** so a player sees their own face, as others do *(as the renderer works today)*.
- **Nothing is sent over the wire.** The client already has everything it needs.
- **Portals off, or no window on screen: nothing changes.** Same pixels, and the bench hashes hold.

## Goals, non-goals, anti-goals

- **Goal:** a player looking through a portal that leads back toward them sees themselves, as others see them.
- **Non-goals:**
  - a true mirror image (discs face the viewer);
  - seeing oneself in the floor mirror of the direct view.
- **Anti-goals:**
  - the own avatar appearing in the direct view, or in front of the eye;
  - any change with portals off;
  - a per-frame allocation.

## Approaches

- **Chosen: add the own avatar to the window passes' people.** `frame.ts` already hands each window level the
  scene's people (`beyond.people = scene.people`). The window levels get the same list plus one extra sprite for the
  local player, built each frame from the local pose and face with no allocation. Labels likewise.
- **Rejected: draw a separate "mirror copy" of the player on the doorway.** It would duplicate the window's job and get
  depth and nested windows wrong.

## Left to the builder

- **Where the own sprite is built:** next to `world.sprites` in the room loop, or from `localPlayer` (its pose, bob and
  held item), and the own face texture (the one the own glow already uses).
- **How its face is kept subscribed and fresh:** it's the local camera, so there is no subscription.
- **How the window levels get the extra sprite and label** without changing what the main pass draws.
- **The facts map for dynamic subscription** (`seen`) must not count the local player.
- Record it as an amendment under D27, which states the gap.
