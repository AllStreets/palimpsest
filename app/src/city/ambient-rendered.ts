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
      44.9,
      19.5,
      14.9
    ],
    "shade": [
      36.9,
      13.7,
      7.8
    ]
  },
  "walkup:buff": {
    "sun": [
      52.9,
      16.7,
      19.9
    ],
    "shade": [
      42,
      11.9,
      9.8
    ]
  },
  "walkup:ironspot": {
    "sun": [
      40.2,
      13.2,
      10.3
    ],
    "shade": [
      36.1,
      10.6,
      6
    ]
  },
  "walkup:white": {
    "sun": [
      59.5,
      13,
      13.7
    ],
    "shade": [
      46.7,
      10.7,
      3.6
    ]
  },
  "walkup:black": {
    "sun": [
      37.8,
      11.2,
      8.2
    ],
    "shade": [
      35.2,
      10.1,
      5
    ]
  },
  "walkup:sage": {
    "sun": [
      43.5,
      10.9,
      10.4
    ],
    "shade": [
      38.7,
      9.4,
      5.1
    ]
  },
  "walkup:grey": {
    "sun": [
      46.2,
      13.3,
      11.2
    ],
    "shade": [
      40.2,
      10.3,
      4.8
    ]
  },
  "walkup:navy": {
    "sun": [
      36.5,
      10.8,
      6.7
    ],
    "shade": [
      35.3,
      10.3,
      4.3
    ]
  },
  "walkup:cream": {
    "sun": [
      59.1,
      13.1,
      15.8
    ],
    "shade": [
      45.8,
      10.7,
      5.3
    ]
  },
  "commercial:limestone": {
    "sun": [
      42.9,
      12.4,
      9.8
    ],
    "shade": [
      40.3,
      10.7,
      4.6
    ]
  },
  "commercial:white-terracotta": {
    "sun": [
      46,
      12.1,
      9.5
    ],
    "shade": [
      43.3,
      10.8,
      3.6
    ]
  },
  "commercial:buff": {
    "sun": [
      41.4,
      13.5,
      12.2
    ],
    "shade": [
      41.1,
      11.6,
      7.6
    ]
  },
  "commercial:granite": {
    "sun": [
      37,
      11.3,
      6.8
    ],
    "shade": [
      38.6,
      10.8,
      4.1
    ]
  },
  "commercial:black": {
    "sun": [
      33.9,
      11,
      6.5
    ],
    "shade": [
      37.6,
      10.7,
      4.9
    ]
  },
  "commercial:green-terracotta": {
    "sun": [
      39.3,
      10.2,
      9.3
    ],
    "shade": [
      42.4,
      8.1,
      7.1
    ]
  },
  "commercial:brownstone": {
    "sun": [
      38.2,
      12.9,
      10.1
    ],
    "shade": [
      41.1,
      9.4,
      7.5
    ]
  },
  "commercial:blue": {
    "sun": [
      40.6,
      11.4,
      7.8
    ],
    "shade": [
      43,
      8.7,
      5.1
    ]
  },
  "midcentury:teal": {
    "sun": [
      39.1,
      8.6,
      6.8
    ],
    "shade": [
      34.9,
      9.1,
      4.6
    ]
  },
  "midcentury:enamel": {
    "sun": [
      37.5,
      10.1,
      6.7
    ],
    "shade": [
      34.1,
      9.7,
      4.9
    ]
  },
  "midcentury:white": {
    "sun": [
      48.6,
      11.1,
      8.4
    ],
    "shade": [
      40.6,
      10,
      2.8
    ]
  },
  "midcentury:slate": {
    "sun": [
      36.6,
      10.1,
      5.1
    ],
    "shade": [
      34.6,
      9.8,
      3.3
    ]
  },
  "midcentury:mies": {
    "sun": [
      35.4,
      9.8,
      5.6
    ],
    "shade": [
      35.2,
      9.6,
      4.7
    ]
  },
  "midcentury:olive": {
    "sun": [
      37.1,
      9.3,
      7.5
    ],
    "shade": [
      36.6,
      9.5,
      5.3
    ]
  },
  "midcentury:sky": {
    "sun": [
      40.2,
      9.3,
      4.3
    ],
    "shade": [
      38.5,
      9.6,
      2.5
    ]
  },
  "glass:silver": {
    "sun": [
      39.1,
      9.4,
      6
    ],
    "shade": [
      43.7,
      10.6,
      5.9
    ]
  },
  "glass:teal": {
    "sun": [
      33.8,
      8,
      5.6
    ],
    "shade": [
      42,
      10.9,
      6
    ]
  },
  "glass:blue": {
    "sun": [
      32.7,
      9.5,
      4.3
    ],
    "shade": [
      45,
      11.5,
      8.3
    ]
  },
  "glass:charcoal": {
    "sun": [
      32.8,
      9.4,
      5.4
    ],
    "shade": [
      45.2,
      11.8,
      8.4
    ]
  },
  "glass:smoked": {
    "sun": [
      34.2,
      10,
      7.5
    ],
    "shade": [
      31,
      9.9,
      5.8
    ]
  },
  "glass:bronze": {
    "sun": [
      35.7,
      10.8,
      8.7
    ],
    "shade": [
      31.3,
      10.3,
      5.6
    ]
  },
  "glass:white": {
    "sun": [
      45.7,
      8.8,
      9.1
    ],
    "shade": [
      35.6,
      9.8,
      3.8
    ]
  },
  "brutalist:grey": {
    "sun": [
      45.2,
      13,
      10.7
    ],
    "shade": [
      37.2,
      10.3,
      4.1
    ]
  },
  "brutalist:cool": {
    "sun": [
      44.7,
      12.4,
      9.3
    ],
    "shade": [
      36.8,
      10.1,
      2.8
    ]
  },
  "brutalist:pale": {
    "sun": [
      52.8,
      13.6,
      13.1
    ],
    "shade": [
      42.5,
      10.6,
      3.8
    ]
  },
  "brutalist:dark": {
    "sun": [
      36.3,
      10.9,
      7.5
    ],
    "shade": [
      32.1,
      9.8,
      4.2
    ]
  },
  "brutalist:buff": {
    "sun": [
      46.2,
      14.7,
      14.6
    ],
    "shade": [
      37.7,
      10.9,
      6.5
    ]
  },
  "parking:grey": {
    "sun": [
      46.1,
      11.4,
      7.6
    ],
    "shade": [
      40.2,
      8.7,
      2.1
    ]
  },
  "parking:pale": {
    "sun": [
      51,
      11.3,
      8.6
    ],
    "shade": [
      43.6,
      8.7,
      2
    ]
  },
  "parking:dark": {
    "sun": [
      39.4,
      10.2,
      5.5
    ],
    "shade": [
      37.6,
      8.4,
      2.3
    ]
  },
  "parking:mesh": {
    "sun": [
      41.9,
      11.6,
      7.7
    ],
    "shade": [
      37.4,
      10.3,
      3.1
    ]
  },
  "industrial:red": {
    "sun": [
      36.5,
      17.4,
      10.4
    ],
    "shade": [
      39,
      12.1,
      5.3
    ]
  },
  "industrial:white": {
    "sun": [
      49.5,
      12.4,
      10.9
    ],
    "shade": [
      47.5,
      10.4,
      3.2
    ]
  },
  "industrial:limewash": {
    "sun": [
      59.9,
      10.8,
      12.1
    ],
    "shade": [
      42.3,
      10.5,
      3.8
    ]
  },
  "industrial:green": {
    "sun": [
      44.3,
      9.5,
      9.3
    ],
    "shade": [
      32.2,
      9.6,
      5.3
    ]
  },
  "industrial:buff": {
    "sun": [
      51.5,
      13.2,
      15.1
    ],
    "shade": [
      36.5,
      11.1,
      7.8
    ]
  },
  "industrial:steel": {
    "sun": [
      44,
      11.6,
      9.9
    ],
    "shade": [
      36.6,
      9.6,
      3.1
    ]
  },
  "industrial:blue": {
    "sun": [
      38.2,
      9.8,
      6.7
    ],
    "shade": [
      34.2,
      9.3,
      2.7
    ]
  }
};

/** The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it. */
export const AMBIENT_INPUTS = '7114c5dce330876f';
