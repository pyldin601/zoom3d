# Ray tracing spike (throwaway)

LEVEL1 lit by rays instead of the current renderer's lighting tricks, to judge the look and the cost on phones before
designing it into the game. No tests; not wired into the app.

- `trace.ts`: the one ray walk. Walls are full height, so a 3D ray is a 2D grid walk plus a height check.
- `bake.ts`: once per map, every floor, ceiling and wall light sample fires shadow rays at the lamps (soft shadows) and
  16 cosine-weighted rays into the room, twice (bounce light). Wall light is baked at 3 heights (or 8).
- `render.ts`: walls per column, floor and ceiling per row, lit from the bake; people and lamps are round things rays
  test. Reflections are traced at 1/2 or 1/4 resolution: one extra 2D walk per column off a wall, none off the floor.
  A rough surface reflects a cone (roughness² wide, stretched along the view at grazing angles): round things meet it
  as a soft blob in closed form, walls and floor through prefiltered texture and light. No screen-space blur.
- `main.ts`, `page.html`: the page, with a switch to the current renderer, frame timings per phase.

```bash
node spikes/raytrace/build.mjs
```

Open `spikes/raytrace/dist/index.html`; `dist/raytrace.html` is the same page body, as published.
