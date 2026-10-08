# Vision

## One-liner
A video meeting that feels like standing in a room: walk around a retro 3D maze, and hear
and see people in proportion to where they are.

## Core experience
1. Host creates a room and shares an invite link.
2. Invitee opens the link, grants camera + mic, and spawns in the map.
3. Each participant is a **round avatar** (billboard) whose texture is their live face video.
   Avatars always face the viewer, like Wolfenstein/Doom sprites.
4. Move with keyboard (WASD/arrows + turn; mouse look optional). First-person
   Wolfenstein-style ray-casting view of a grid maze.
5. Audio is spatial: louder when near, quieter when far, panned left/right by bearing,
   with room reverb and a surround feel so it sounds like a shared space.

## Goals
- Feels retro (low-res, flat-shaded walls, textured grid maze) but works smoothly in a browser.
- Small-group meetings first (target: up to ~8 participants; stretch: more).
- Low friction: link -> permissions -> in the room. No install.

## Non-goals (for now)
- Interactive map elements (doors, pickups, screens), combat, game rules.
- Native apps, mobile-first controls.
- Recording, chat history, screen sharing.
- Accounts/identity beyond what invites require.

## Success criteria (v1)
- Two+ people in different networks can join by link, see each other's faces as avatars,
  and walk around.
- Closing your eyes you can tell roughly where a speaker is and how far away.
- Render stays at a steady 60 fps on a mid laptop with 8 participants.
