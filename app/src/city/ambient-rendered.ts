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
      31.9,
      27.1,
      17.6
    ],
    "shade": [
      17.5,
      11.5,
      3.3
    ]
  },
  "walkup:buff": {
    "sun": [
      47.4,
      20.5,
      26.2
    ],
    "shade": [
      26.4,
      9.5,
      8
    ]
  },
  "walkup:ironspot": {
    "sun": [
      22.8,
      13.3,
      8.7
    ],
    "shade": [
      16.8,
      6.1,
      0.5
    ]
  },
  "walkup:white": {
    "sun": [
      58.2,
      13.7,
      13.6
    ],
    "shade": [
      33.8,
      8.6,
      -0.6
    ]
  },
  "walkup:black": {
    "sun": [
      18.8,
      8.3,
      5
    ],
    "shade": [
      14.5,
      5,
      0.5
    ]
  },
  "walkup:sage": {
    "sun": [
      31.8,
      9.2,
      10.2
    ],
    "shade": [
      19.8,
      5,
      -0.7
    ]
  },
  "walkup:grey": {
    "sun": [
      36.9,
      14.6,
      12.5
    ],
    "shade": [
      23.1,
      7,
      -0.8
    ]
  },
  "walkup:navy": {
    "sun": [
      16.5,
      7.1,
      2.9
    ],
    "shade": [
      15.8,
      5.7,
      -0.7
    ]
  },
  "walkup:cream": {
    "sun": [
      58.2,
      13.3,
      16.3
    ],
    "shade": [
      37.1,
      10.3,
      3.3
    ]
  },
  "commercial:limestone": {
    "sun": [
      38.4,
      11.5,
      3.5
    ],
    "shade": [
      31.1,
      8.1,
      -5.2
    ]
  },
  "commercial:white-terracotta": {
    "sun": [
      43.4,
      11.1,
      2.5
    ],
    "shade": [
      36.6,
      9,
      -6.3
    ]
  },
  "commercial:buff": {
    "sun": [
      35.7,
      13.2,
      8.1
    ],
    "shade": [
      30.5,
      9.2,
      1.7
    ]
  },
  "commercial:granite": {
    "sun": [
      27.7,
      9.2,
      -2.1
    ],
    "shade": [
      28.4,
      7.7,
      -5.7
    ]
  },
  "commercial:black": {
    "sun": [
      21.2,
      7.6,
      -3.4
    ],
    "shade": [
      27,
      7.3,
      -4.6
    ]
  },
  "commercial:green-terracotta": {
    "sun": [
      26.5,
      6.3,
      2.1
    ],
    "shade": [
      27.4,
      2.4,
      0
    ]
  },
  "commercial:brownstone": {
    "sun": [
      25.8,
      12.7,
      3.3
    ],
    "shade": [
      26.2,
      5.1,
      0.4
    ]
  },
  "commercial:blue": {
    "sun": [
      31.3,
      10.2,
      0.3
    ],
    "shade": [
      28.7,
      4.5,
      -1.9
    ]
  },
  "midcentury:teal": {
    "sun": [
      40,
      9,
      -0.9
    ],
    "shade": [
      31.1,
      5.5,
      -7.9
    ]
  },
  "midcentury:enamel": {
    "sun": [
      43.4,
      11,
      1
    ],
    "shade": [
      33.7,
      6.5,
      -7.5
    ]
  },
  "midcentury:white": {
    "sun": [
      50.5,
      10.6,
      0.4
    ],
    "shade": [
      39.4,
      7.4,
      -7.5
    ]
  },
  "midcentury:slate": {
    "sun": [
      31,
      9,
      -3.2
    ],
    "shade": [
      28.7,
      5.7,
      -6.9
    ]
  },
  "midcentury:mies": {
    "sun": [
      23.3,
      6.6,
      -6.2
    ],
    "shade": [
      28.1,
      5.4,
      -6.8
    ]
  },
  "midcentury:olive": {
    "sun": [
      36.6,
      10.3,
      1.6
    ],
    "shade": [
      33.8,
      6.3,
      -4
    ]
  },
  "midcentury:sky": {
    "sun": [
      41.6,
      10.1,
      -4.1
    ],
    "shade": [
      39,
      6.9,
      -7.2
    ]
  },
  "glass:silver": {
    "sun": [
      44.7,
      8.5,
      -12.3
    ],
    "shade": [
      37.5,
      6.9,
      0
    ]
  },
  "glass:teal": {
    "sun": [
      35,
      6.2,
      -16.2
    ],
    "shade": [
      31.2,
      7.1,
      2.1
    ]
  },
  "glass:blue": {
    "sun": [
      33.8,
      8.2,
      -18.5
    ],
    "shade": [
      37.9,
      8.9,
      8.4
    ]
  },
  "glass:charcoal": {
    "sun": [
      30.4,
      8,
      -16.8
    ],
    "shade": [
      33.8,
      9.8,
      10.1
    ]
  },
  "glass:smoked": {
    "sun": [
      37.3,
      8.1,
      -9.1
    ],
    "shade": [
      34.1,
      8.4,
      -20
    ]
  },
  "glass:bronze": {
    "sun": [
      38.4,
      9.6,
      -8.1
    ],
    "shade": [
      33.3,
      8.6,
      -18.6
    ]
  },
  "glass:white": {
    "sun": [
      50,
      9.1,
      -7.6
    ],
    "shade": [
      39.4,
      8.6,
      -18.1
    ]
  },
  "brutalist:grey": {
    "sun": [
      37.9,
      13.9,
      12.9
    ],
    "shade": [
      17.9,
      5.9,
      -2.4
    ]
  },
  "brutalist:cool": {
    "sun": [
      36.6,
      12.8,
      10.1
    ],
    "shade": [
      15.4,
      5.5,
      -4.6
    ]
  },
  "brutalist:pale": {
    "sun": [
      51.8,
      14.9,
      16.5
    ],
    "shade": [
      26.5,
      7.8,
      -1.2
    ]
  },
  "brutalist:dark": {
    "sun": [
      18.8,
      8.1,
      6.9
    ],
    "shade": [
      5.2,
      2.8,
      -2
    ]
  },
  "brutalist:buff": {
    "sun": [
      41.1,
      17.3,
      21.8
    ],
    "shade": [
      17.6,
      7.2,
      3.6
    ]
  },
  "parking:grey": {
    "sun": [
      36.6,
      10.9,
      8.6
    ],
    "shade": [
      22.4,
      3.2,
      -2.5
    ]
  },
  "parking:pale": {
    "sun": [
      45.2,
      10.8,
      9.7
    ],
    "shade": [
      28.5,
      4.1,
      -2.2
    ]
  },
  "parking:dark": {
    "sun": [
      22.6,
      7.3,
      4.5
    ],
    "shade": [
      17.2,
      2,
      -3
    ]
  },
  "parking:mesh": {
    "sun": [
      29.2,
      11.1,
      9
    ],
    "shade": [
      15.7,
      5.9,
      -0.9
    ]
  },
  "industrial:red": {
    "sun": [
      25.7,
      22.2,
      6.2
    ],
    "shade": [
      28.3,
      10.2,
      -2.7
    ]
  },
  "industrial:white": {
    "sun": [
      49,
      11.5,
      4.8
    ],
    "shade": [
      42,
      8.8,
      -3.9
    ]
  },
  "industrial:limewash": {
    "sun": [
      60.5,
      10.3,
      10
    ],
    "shade": [
      33.9,
      8.6,
      -7.8
    ]
  },
  "industrial:green": {
    "sun": [
      33.5,
      6.8,
      6.6
    ],
    "shade": [
      14.5,
      4.5,
      -7.1
    ]
  },
  "industrial:buff": {
    "sun": [
      48,
      14.5,
      17.8
    ],
    "shade": [
      23.8,
      8.1,
      -1.3
    ]
  },
  "industrial:steel": {
    "sun": [
      34.5,
      11.4,
      10
    ],
    "shade": [
      14,
      5.3,
      -5
    ]
  },
  "industrial:blue": {
    "sun": [
      22.9,
      6.2,
      4
    ],
    "shade": [
      9.3,
      3.8,
      -5.9
    ]
  }
};

/** The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it. */
export const AMBIENT_INPUTS = 'rows walkup:red=0c488199e0;walkup:buff=f6c16d0bfe;walkup:ironspot=63856cafb1;walkup:white=8ce58c9230;walkup:black=ef36fbcbc3;walkup:sage=d69a0a6cab;walkup:grey=86fdbefa98;walkup:navy=0c19ce0b9d;walkup:cream=fd01ed2a31;commercial:limestone=c48d8b7994;commercial:white-terracotta=2492b69e02;commercial:buff=d5b7feb2d1;commercial:granite=27163e029c;commercial:black=e888dbf2d3;commercial:green-terracotta=7becc81ddc;commercial:brownstone=9a2d13a29c;commercial:blue=f7cae3890f;midcentury:teal=2bc89c78e8;midcentury:enamel=753d21162c;midcentury:white=ae3731e2d4;midcentury:slate=b60fc656bf;midcentury:mies=97026e5e07;midcentury:olive=34db9c227f;midcentury:sky=2121b4ff21;glass:silver=cdbb97efef;glass:teal=2b1b3cf507;glass:blue=3e520aefa0;glass:charcoal=672a89b782;glass:smoked=e0d7ae8893;glass:bronze=bb9894fe96;glass:white=74e075bf54;brutalist:grey=d6045a9959;brutalist:cool=e4a2e70bd1;brutalist:pale=974997824d;brutalist:dark=e9b3116d64;brutalist:buff=2338771e55;parking:grey=948ef90132;parking:pale=2f2266631e;parking:dark=45388581c7;parking:mesh=4710c3e446;industrial:red=9207560f7c;industrial:white=9bb6e3ea8e;industrial:limewash=e057189445;industrial:green=6693e30d28;industrial:buff=85cef1fedc;industrial:steel=aff70c8f88;industrial:blue=a28e4be1bd';
