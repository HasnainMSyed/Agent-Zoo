// The first message of a "Make a mascot" session: Claude draws a new pack in an empty folder.
// It spells out the pack format and the animation hooks the app's CSS drives (see mascot.css).

export function makeMascotPrompt(description: string, folder: string): string {
  return `Please design a new mascot pack for Prompt Habitat, a desktop app for coding agents. Mascots sit next to the input box and animate with the session's state.

What I'd like: ${description.trim()}

Write exactly two files in this folder (${folder}), and nothing else:

1. mascot.svg
   - viewBox="0 0 120 120", no width/height attributes. The figure should stand on the bottom edge, roughly 70-90 units tall, centred.
   - Plain SVG only: no <script>, no <foreignObject>, no event handlers, no external links or fonts (#ids and data:image URLs are fine).
   - Put the whole figure in <g class="body"> so it can bob, sway, hop and shake.
   - Eyes in <g class="eyes"> with these alternatives inside it:
     <g class="e-open"> normal eyes (they blink), <g class="e-happy"> happy eyes (shown when done),
     <g class="e-x"> x-eyes (shown on error). Optionally add class="sad-face" on the body group plus
     <g class="e-sad"> and a mouth pair <g class="m-ok"> / <g class="m-sad"> for a sad error face.
   - Optional extras the app animates: .spin (slow rotation), .orbit (circles the centre), .halo (pulses),
     .fa/.fb (two alternating frames), .cursor (blinks), .ring (dashed stroke that runs).
   - A soft shadow ellipse under the figure, outside .body, looks good: <ellipse cx="60" cy="109" rx="28" ry="4" fill="#000" opacity=".4"/>.
   - Keep it small (under 50 KB) and readable at 30 px as well as 120 px.

2. mascot.json
   {"name": "<a short name>", "description": "<one sentence>", "version": 1}

The design must be original: not a copy of any existing character, brand logo or official mascot.
When both files are written, tell me the name you chose in one line. The app picks the new pack up by itself.`;
}
