/**
 * Each variant's colour as the city renders it at the overview's distance
 * and bearing: CIE Lab of the sunlit and the shaded face, with floors at
 * tall-tower height (sun, shade) and at short-tower height over the street
 * (sunLow, shadeLow). Measured by tools/capture.ts, the swatches shot.
 *
 * VERSIONED DATA. pickLooks chooses every tower's materials from these
 * numbers, so regenerating this file is a city-wide look change: towers
 * people already know can change their materials. Nothing regenerates it
 * on its own (not the build, the tests or any default capture); only
 * `SWATCH_WRITE=1 node --import tsx tools/capture.ts swatches`, run by
 * hand as a deliberate change and committed with the reason.
 *
 * Round 5 of Task B merged by hand (2026-11-09): the six sci-fi family
 * entries are new measurements. Every other entry is the round 4
 * measurement, kept on purpose so no known tower's stone or brick moved:
 * stone:sandstone and brick:cream were retinted that round by a few units
 * (sandstone sun L44.2 to 43.8, cream sun L55.0 to 52.8 when re-measured),
 * inside the margin PREFERRED leaves for a measurement to drift.
 */
export const RENDERED: Record<string, { sun: [number, number, number]; shade: [number, number, number]; sunLow?: [number, number, number]; shadeLow?: [number, number, number] }> = {
  "stone:limestone": {
    "sun": [
      52.3,
      12.9,
      11.1
    ],
    "shade": [
      42.7,
      10.9,
      4
    ],
    "sunLow": [
      52.2,
      12.6,
      10.9
    ],
    "shadeLow": [
      43.7,
      10.9,
      4.4
    ]
  },
  "stone:sandstone": {
    "sun": [
      46.1,
      12.6,
      15.2
    ],
    "shade": [
      39.2,
      10.2,
      9.3
    ],
    "sunLow": [
      46.5,
      11.6,
      13.2
    ],
    "shadeLow": [
      40.4,
      10,
      8.5
    ]
  },
  "stone:pink-granite": {
    "sun": [
      47.3,
      16.7,
      12.2
    ],
    "shade": [
      39.6,
      13.1,
      6.3
    ],
    "sunLow": [
      47.3,
      15.9,
      11.8
    ],
    "shadeLow": [
      39.6,
      13.3,
      6.2
    ]
  },
  "stone:dark-granite": {
    "sun": [
      39.4,
      11.8,
      10.5
    ],
    "shade": [
      33.4,
      10.4,
      6.2
    ],
    "sunLow": [
      39.5,
      11.5,
      9.8
    ],
    "shadeLow": [
      34.4,
      10.6,
      6.3
    ]
  },
  "stone:marble": {
    "sun": [
      56.8,
      12.1,
      9.1
    ],
    "shade": [
      46.6,
      10.6,
      1.3
    ],
    "sunLow": [
      57.6,
      11.8,
      9.3
    ],
    "shadeLow": [
      47.4,
      10.7,
      2.2
    ]
  },
  "stone:travertine": {
    "sun": [
      41.3,
      14.5,
      12.8
    ],
    "shade": [
      36.8,
      11.6,
      7.4
    ],
    "sunLow": [
      41.1,
      13.6,
      11.4
    ],
    "shadeLow": [
      37.2,
      11.6,
      7.6
    ]
  },
  "brick:red": {
    "sun": [
      39.7,
      13.1,
      10.1
    ],
    "shade": [
      38.3,
      10.4,
      7.2
    ],
    "sunLow": [
      39.9,
      13,
      9.7
    ],
    "shadeLow": [
      38.7,
      10.6,
      7.3
    ]
  },
  "brick:cream": {
    "sun": [
      51.1,
      13.6,
      17.3
    ],
    "shade": [
      44.6,
      10.3,
      9.1
    ],
    "sunLow": [
      49.7,
      13.4,
      16.2
    ],
    "shadeLow": [
      44.7,
      10.7,
      9.7
    ]
  },
  "brick:ironspot": {
    "sun": [
      38.7,
      12.9,
      10.9
    ],
    "shade": [
      32.7,
      10.9,
      6.1
    ],
    "sunLow": [
      39.3,
      12.7,
      10.3
    ],
    "shadeLow": [
      33.4,
      11,
      6.3
    ]
  },
  "brick:terracotta": {
    "sun": [
      54.7,
      12,
      7.7
    ],
    "shade": [
      47.6,
      10.7,
      1.2
    ],
    "sunLow": [
      54.2,
      11.8,
      7.5
    ],
    "shadeLow": [
      47.3,
      10.5,
      1.4
    ]
  },
  "brick:green-terracotta": {
    "sun": [
      36.6,
      9.3,
      7.2
    ],
    "shade": [
      33.6,
      9.5,
      5.2
    ],
    "sunLow": [
      38.1,
      10.2,
      7.8
    ],
    "shadeLow": [
      34.6,
      9.6,
      4.9
    ]
  },
  "brick:salmon": {
    "sun": [
      45.8,
      18.6,
      14.6
    ],
    "shade": [
      40.8,
      14,
      9.3
    ],
    "sunLow": [
      46.7,
      17.5,
      13.9
    ],
    "shadeLow": [
      41,
      13.1,
      8.5
    ]
  },
  "glass:green": {
    "sun": [
      44.8,
      5.3,
      3.6
    ],
    "shade": [
      42.5,
      7,
      4.6
    ],
    "sunLow": [
      44,
      6.6,
      4.3
    ],
    "shadeLow": [
      39.9,
      7.8,
      4.2
    ]
  },
  "glass:bronze": {
    "sun": [
      43.1,
      12.2,
      13.9
    ],
    "shade": [
      38.1,
      12.9,
      10.7
    ],
    "sunLow": [
      42.8,
      12.3,
      13.2
    ],
    "shadeLow": [
      35.8,
      12.3,
      8.4
    ]
  },
  "glass:blue": {
    "sun": [
      42.2,
      8.2,
      -2.1
    ],
    "shade": [
      42.6,
      8.3,
      -3.2
    ],
    "sunLow": [
      44.4,
      8.1,
      -3.7
    ],
    "shadeLow": [
      47.6,
      9.4,
      3.4
    ]
  },
  "glass:black": {
    "sun": [
      42.8,
      8.7,
      9.6
    ],
    "shade": [
      36.7,
      9.1,
      6.5
    ],
    "sunLow": [
      40.5,
      9.2,
      8.5
    ],
    "shadeLow": [
      39.8,
      9,
      7.4
    ]
  },
  "glass:channel": {
    "sun": [
      65.6,
      8.1,
      17
    ],
    "shade": [
      60.7,
      8.4,
      13.4
    ],
    "sunLow": [
      64.6,
      8.3,
      16.2
    ],
    "shadeLow": [
      58.7,
      9,
      12.1
    ]
  },
  "titanium:titanium": {
    "sun": [
      41.5,
      9.8,
      6.1
    ],
    "shade": [
      38.5,
      10.9,
      1.7
    ],
    "sunLow": [
      42.5,
      9.3,
      5.7
    ],
    "shadeLow": [
      39.1,
      10.9,
      1.4
    ]
  },
  "titanium:zinc": {
    "sun": [
      37.5,
      9.1,
      2.9
    ],
    "shade": [
      33,
      9.9,
      3.3
    ],
    "sunLow": [
      39.5,
      8.9,
      2.2
    ],
    "shadeLow": [
      34.1,
      10.1,
      3.5
    ]
  },
  "titanium:copper": {
    "sun": [
      34.3,
      9.4,
      5.7
    ],
    "shade": [
      38.2,
      6.6,
      4.7
    ],
    "sunLow": [
      35.7,
      9.2,
      5.8
    ],
    "shadeLow": [
      39.3,
      6.7,
      5
    ]
  },
  "titanium:bronze": {
    "sun": [
      43.2,
      12.6,
      12
    ],
    "shade": [
      35,
      13.2,
      8.5
    ],
    "sunLow": [
      46.1,
      12.4,
      14.4
    ],
    "shadeLow": [
      35.5,
      12.9,
      7.9
    ]
  },
  "titanium:black": {
    "sun": [
      31.7,
      10.2,
      5.4
    ],
    "shade": [
      29.3,
      9.7,
      4.3
    ],
    "sunLow": [
      31.9,
      10,
      5.1
    ],
    "shadeLow": [
      30.2,
      9.8,
      4.5
    ]
  },
  "scifi:deco": {
    "sun": [
      41.9,
      10,
      6.6
    ],
    "shade": [
      37,
      11.9,
      6.5
    ],
    "sunLow": [
      42.6,
      10,
      6.5
    ],
    "shadeLow": [
      36.9,
      11.9,
      6.3
    ]
  },
  "scifi:ziggurat": {
    "sun": [
      37.9,
      11.2,
      10.1
    ],
    "shade": [
      42.1,
      10.8,
      6.2
    ],
    "sunLow": [
      37.9,
      11.3,
      9.6
    ],
    "shadeLow": [
      38.4,
      10.9,
      6.4
    ]
  },
  "scifi:needle": {
    "sun": [
      47.3,
      6.7,
      -3.7
    ],
    "shade": [
      40.6,
      10.9,
      5
    ],
    "sunLow": [
      45.6,
      7.3,
      -3.1
    ],
    "shadeLow": [
      35,
      10.7,
      4.2
    ]
  },
  "scifi:arcology": {
    "sun": [
      44.3,
      9.8,
      9.2
    ],
    "shade": [
      40.7,
      12.3,
      7.5
    ],
    "sunLow": [
      45,
      9.4,
      9.4
    ],
    "shadeLow": [
      38.8,
      11.6,
      6.4
    ]
  },
  "scifi:organic": {
    "sun": [
      44.6,
      8.6,
      2
    ],
    "shade": [
      46.8,
      11.2,
      5
    ],
    "sunLow": [
      46.6,
      8.6,
      1.9
    ],
    "shadeLow": [
      39.4,
      11.5,
      5.5
    ]
  },
  "scifi:cluster": {
    "sun": [
      48,
      6.6,
      -1.8
    ],
    "shade": [
      47.9,
      11.5,
      5.9
    ],
    "sunLow": [
      46.4,
      7,
      -1.4
    ],
    "shadeLow": [
      38.8,
      10.9,
      6.4
    ]
  }
};

/** The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it. */
export const RENDERED_INPUTS = 'b493ff76e3c8562a';
