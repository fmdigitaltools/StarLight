# StarLight Requirements

## At a glance

| | Minimum | Recommended |
|---|---|---|
| System | Windows 10, 64-bit | Windows 11, 64-bit |
| Memory (RAM) | 8 GB | 16 GB; 32 GB or more for full frame sensors with many frames |
| Graphics card | with WebGL 2 and floating-point textures: any recent integrated or dedicated card | a dedicated card, for sliders that are always smooth on large images |
| Processor | any 64-bit processor | as many cores as possible, because stacking and Process use them all |
| Disk space | about 380 MB for the program | in addition, space for the captures and for the optional catalogs |

## Operating system

StarLight runs on Windows 10 and Windows 11, 64-bit. The installation is for the current user and does not require
administrator permissions.

## Graphics card

The corrections of the Correct and Filters steps and the viewer are computed by the graphics card, which processes all
the pixels at once, and for this reason the image changes while the sliders are being moved. A card that supports
**WebGL 2** with **floating-point textures** is required. Cards integrated in the processor and dedicated cards from
recent years are suitable, provided their drivers are up to date.

- Recent cards accept images up to 16384 pixels per side. If an image exceeds the card's limit, or the
  card does not have enough memory, the viewer shows it reduced; at high magnifications it appears less sharp, but
  calculations and export always use the full data.
- On laptops with two cards, **Settings**, **Performance** tab, lets one choose whether to use the dedicated card (smoother)
  or leave the choice to the system (longer battery life).
- With a card lacking WebGL 2, "Use graphics acceleration" can be turned off in the same tab; drawing
  moves to the processor, which is slower.

## Disk space

| Item | Space |
|---|---|
| installer | about 118 MB |
| installed program | about 380 MB |
| each optional object catalog | a few MB |
| star package for plate solving without internet | about 16 MB |

Space for the captures must be calculated separately, because the raw frames of one night often take up several gigabytes.

## Memory

With large sensors, the limit of stacking is not time but memory, because every analyzed frame stays in memory
until the final sum. StarLight keeps 16-bit frames in compact form (2 bytes per pixel for raw frames with
the Bayer mosaic), so many of them fit even with little memory.

### Stackable frames

The table shows how many raw color frames (Bayer mosaic, 16-bit FITS files) StarLight stacks at once,
depending on the installed memory and the sensor resolution. The values come from the same estimate that the program
performs before every stacking, with a single analysis process, assuming that Windows and the other open programs
take up 3 to 4 GB; the first number applies with 4 GB in use, the second with 3 GB. In parentheses are the
values with dark and flat calibration from the library, which takes up the space of a few more frames.

| Sensor | 8 GB | 16 GB | 32 GB | 64 GB |
|---|---|---|---|---|
| 2 MP (1920 × 1080) | 610-869 (608-867) | 2475-2695 (2473-2693) | 5996-6216 (5994-6214) | 13038-13258 (13036-13256) |
| 8 MP (3840 × 2160) | 143-208 (141-206) | 609-664 (607-662) | 1490-1545 (1488-1543) | 3250-3305 (3248-3303) |
| 26 MP (6248 × 4176) | 37-58 (35-56) | 185-203 (183-201) | 465-482 (463-480) | 1025-1042 (1023-1040) |
| 45 MP (8256 × 5504) | 16-28 (14-26) | 101-111 (99-109) | 262-272 (260-270) | 583-593 (581-591) |
| 61 MP (9576 × 6388) | 9-17 (7-15) | 72-79 (70-77) | 191-199 (189-197) | 430-437 (428-435) |

Real measurements on a computer with 8 GB installed and 4 to 5 GB free confirm the estimate: 620-878 frames at 2 MP,
146-211 at 8 MP, 38-59 at 26 MP, 9-18 at 61 MP.

Some cases require more memory:

- **drizzle** produces a result with four times the pixels;
- **HDR merge** keeps one sum for each exposure series;
- **comets**, with comet and stars fixed together, keep more sums and rebuild the frames in full;
- **camera RAW** files require additional memory during decoding;
- 32-bit or floating-point files do not stay compact and take up much more (up to six times for color
  frames).

### Behavior with little memory

Before every stacking, StarLight estimates the memory needed and compares it with the free memory, always leaving a
reserve for the system (15% of the free memory, at least 1 GB).

- If the memory is not enough to work with all the analysis processes, StarLight automatically uses fewer of them and
  reports it; stacking takes a little longer but completes.
- If it is not enough even with a single process, it stops before starting, indicates how much memory would be needed and how many
  frames fit, and suggests excluding the extra frames (for example the worst ones) and stacking in several passes, or
  closing other programs.
- To make room, it can release recently opened frames, kept in memory so they can be reopened quickly.

The memory in use is shown in the status bar under RAM, and the memory limit for open frames is
set in **Settings**, **Performance** tab.

### How much memory to choose

- **8 GB**: sufficient for sensors up to 8-26 MP and a few dozen or a few hundred frames.
- **16 GB**: the recommended choice, comfortable even with 26 MP sensors and a couple of hundred frames.
- **32 GB or more**: for full frame sensors of 45-61 MP with many frames, or for high-resolution drizzle.

## Indicative times

On a computer with a 28-core processor:

- 8 frames of 26 MP are stacked in about 5 seconds;
- Abracadabra prepares an 8 MP image in about 13 seconds.

Stacking and the tools of the Process step split the computation across all available cores, and with fewer cores the times
get longer.
