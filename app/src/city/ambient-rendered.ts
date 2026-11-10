/**
 * Each ambient tone's colour as the city renders it at the overview's
 * distance and bearing: CIE Lab of the sunlit and the shaded face of a
 * plain building of its type. Measured by tools/capture.ts, the ambient shot.
 *
 * VERSIONED DATA. The plaza-edge rule in lots.ts chooses tones from these
 * numbers, and the tests hold the palette to them; only
 * `AMBIENT_WRITE=1 node --import tsx tools/capture.ts ambient` regenerates
 * it, by hand, committed with the reason.
 */
export const AMBIENT_RENDERED: Record<string, { sun: [number, number, number]; shade: [number, number, number] }> = {
  "walkup:red": {
    "sun": [
      45,
      19.5,
      14.4
    ],
    "shade": [
      37.6,
      13.4,
      7.9
    ]
  },
  "walkup:buff": {
    "sun": [
      53.4,
      17.1,
      20.5
    ],
    "shade": [
      42.1,
      11.8,
      9.8
    ]
  },
  "walkup:ironspot": {
    "sun": [
      40.4,
      13.3,
      10.5
    ],
    "shade": [
      34.2,
      11,
      5.6
    ]
  },
  "walkup:white": {
    "sun": [
      61.3,
      13.3,
      14.2
    ],
    "shade": [
      47.2,
      10.9,
      3.3
    ]
  },
  "walkup:black": {
    "sun": [
      37.7,
      11.2,
      8.3
    ],
    "shade": [
      35.9,
      10.1,
      5.1
    ]
  },
  "walkup:sage": {
    "sun": [
      44,
      10.9,
      10.6
    ],
    "shade": [
      37.9,
      9.5,
      4.8
    ]
  },
  "walkup:grey": {
    "sun": [
      46,
      13.2,
      11.1
    ],
    "shade": [
      38.6,
      10.5,
      4.3
    ]
  },
  "walkup:navy": {
    "sun": [
      36.9,
      10.9,
      6.8
    ],
    "shade": [
      35.6,
      10.2,
      4.5
    ]
  },
  "walkup:cream": {
    "sun": [
      60.9,
      13.4,
      16.6
    ],
    "shade": [
      47.9,
      10.8,
      5.5
    ]
  },
  "commercial:limestone": {
    "sun": [
      41.8,
      12.2,
      9.4
    ],
    "shade": [
      40.5,
      10.7,
      4.6
    ]
  },
  "commercial:white-terracotta": {
    "sun": [
      44.1,
      11.9,
      9.1
    ],
    "shade": [
      42.8,
      10.8,
      3.7
    ]
  },
  "commercial:buff": {
    "sun": [
      39.9,
      13.1,
      11.1
    ],
    "shade": [
      40.7,
      11.5,
      7.4
    ]
  },
  "commercial:granite": {
    "sun": [
      36.1,
      11.2,
      6.6
    ],
    "shade": [
      38.8,
      10.8,
      4
    ]
  },
  "commercial:black": {
    "sun": [
      33.8,
      11,
      6.4
    ],
    "shade": [
      38.2,
      10.8,
      5
    ]
  },
  "commercial:green-terracotta": {
    "sun": [
      39.5,
      10.2,
      9.4
    ],
    "shade": [
      40.5,
      8.6,
      6.7
    ]
  },
  "commercial:brownstone": {
    "sun": [
      38.5,
      13.2,
      10.2
    ],
    "shade": [
      38.4,
      10,
      7
    ]
  },
  "commercial:blue": {
    "sun": [
      40.8,
      11.5,
      8
    ],
    "shade": [
      40.3,
      9.4,
      4.5
    ]
  },
  "midcentury:teal": {
    "sun": [
      39.3,
      8.6,
      7.2
    ],
    "shade": [
      35.5,
      9,
      4.7
    ]
  },
  "midcentury:enamel": {
    "sun": [
      37.3,
      10.2,
      7
    ],
    "shade": [
      34.5,
      9.7,
      4.8
    ]
  },
  "midcentury:white": {
    "sun": [
      47.9,
      11.3,
      8.7
    ],
    "shade": [
      41,
      9.7,
      2.8
    ]
  },
  "midcentury:slate": {
    "sun": [
      36.2,
      10.3,
      5.3
    ],
    "shade": [
      35.2,
      9.7,
      3.6
    ]
  },
  "midcentury:mies": {
    "sun": [
      34,
      10.2,
      5.8
    ],
    "shade": [
      35.3,
      9.5,
      4.4
    ]
  },
  "midcentury:olive": {
    "sun": [
      36.4,
      9.9,
      8
    ],
    "shade": [
      36.9,
      9.3,
      5.1
    ]
  },
  "midcentury:sky": {
    "sun": [
      39.3,
      9.7,
      4.5
    ],
    "shade": [
      38.5,
      9.6,
      2.3
    ]
  },
  "glass:silver": {
    "sun": [
      39.1,
      9.6,
      5.9
    ],
    "shade": [
      44.4,
      10.7,
      6.1
    ]
  },
  "glass:teal": {
    "sun": [
      33.9,
      8.2,
      5.7
    ],
    "shade": [
      41.9,
      10.6,
      5.5
    ]
  },
  "glass:blue": {
    "sun": [
      32.6,
      9.5,
      4.2
    ],
    "shade": [
      44.8,
      11.9,
      8.7
    ]
  },
  "glass:charcoal": {
    "sun": [
      32.2,
      9.5,
      5.6
    ],
    "shade": [
      44.9,
      12.1,
      8.8
    ]
  },
  "glass:smoked": {
    "sun": [
      35,
      9.8,
      7.8
    ],
    "shade": [
      31.1,
      9.9,
      5.8
    ]
  },
  "glass:bronze": {
    "sun": [
      36,
      10.8,
      8.9
    ],
    "shade": [
      31.3,
      10.4,
      5.6
    ]
  },
  "glass:white": {
    "sun": [
      44.3,
      8.9,
      8.8
    ],
    "shade": [
      36.1,
      9.9,
      3.7
    ]
  },
  "brutalist:grey": {
    "sun": [
      44.2,
      13.1,
      10.3
    ],
    "shade": [
      37.3,
      10.3,
      4.1
    ]
  },
  "brutalist:cool": {
    "sun": [
      42.9,
      12.3,
      8.6
    ],
    "shade": [
      36.6,
      10.1,
      2.9
    ]
  },
  "brutalist:pale": {
    "sun": [
      51.9,
      13.7,
      12.8
    ],
    "shade": [
      41.8,
      10.4,
      3.9
    ]
  },
  "brutalist:dark": {
    "sun": [
      35.2,
      11.2,
      7.3
    ],
    "shade": [
      32.5,
      9.8,
      4.3
    ]
  },
  "brutalist:buff": {
    "sun": [
      45.3,
      14.8,
      14.3
    ],
    "shade": [
      38,
      10.8,
      6.7
    ]
  },
  "parking:grey": {
    "sun": [
      45.2,
      11.6,
      7.7
    ],
    "shade": [
      39.6,
      8.8,
      2.3
    ]
  },
  "parking:pale": {
    "sun": [
      49.9,
      11.9,
      9.2
    ],
    "shade": [
      43.8,
      8.7,
      2
    ]
  },
  "parking:dark": {
    "sun": [
      39.2,
      10.2,
      5.5
    ],
    "shade": [
      38.3,
      8.2,
      2.2
    ]
  },
  "parking:mesh": {
    "sun": [
      41.3,
      11.7,
      7.9
    ],
    "shade": [
      37.7,
      10.3,
      3.1
    ]
  },
  "industrial:red": {
    "sun": [
      35.8,
      16.3,
      9.7
    ],
    "shade": [
      39.2,
      12.1,
      5.4
    ]
  },
  "industrial:white": {
    "sun": [
      46.4,
      12.1,
      10
    ],
    "shade": [
      47,
      10.5,
      3.1
    ]
  },
  "industrial:limewash": {
    "sun": [
      60.1,
      10.8,
      12.2
    ],
    "shade": [
      42.4,
      10.5,
      3.7
    ]
  },
  "industrial:green": {
    "sun": [
      44.1,
      9.5,
      9.3
    ],
    "shade": [
      32.9,
      9.4,
      5.3
    ]
  },
  "industrial:buff": {
    "sun": [
      50.9,
      13.3,
      15.1
    ],
    "shade": [
      36.7,
      11.3,
      8
    ]
  },
  "industrial:steel": {
    "sun": [
      43.6,
      11.7,
      10
    ],
    "shade": [
      36.3,
      9.7,
      3
    ]
  },
  "industrial:blue": {
    "sun": [
      37.7,
      9.9,
      6.7
    ],
    "shade": [
      33.8,
      9.3,
      2.8
    ]
  }
};

/**
 * The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it.
 * Restamped for Task 26 without a re-measure: post.ts and scene.ts name the same bloom threshold and exposure, and
 * the welders' point lights stand dark with no job site, and the floods light only the construction's own materials,
 * so nothing the ambient board renders changed.
 */
export const AMBIENT_INPUTS = '601fd2e6882b1e24';
