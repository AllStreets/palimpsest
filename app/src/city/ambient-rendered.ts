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
      29.7,
      27.3,
      20.3
    ],
    "shade": [
      15.5,
      11.6,
      5.4
    ]
  },
  "walkup:buff": {
    "sun": [
      45.6,
      20.6,
      28.2
    ],
    "shade": [
      24.9,
      9.5,
      9.7
    ]
  },
  "walkup:ironspot": {
    "sun": [
      20.4,
      13.3,
      11.2
    ],
    "shade": [
      14.6,
      5.8,
      2.6
    ]
  },
  "walkup:white": {
    "sun": [
      56.3,
      13.6,
      15.6
    ],
    "shade": [
      32.6,
      8.5,
      0.6
    ]
  },
  "walkup:black": {
    "sun": [
      16.7,
      8.1,
      7.2
    ],
    "shade": [
      13.4,
      4.9,
      1.6
    ]
  },
  "walkup:sage": {
    "sun": [
      29.9,
      9.1,
      12.3
    ],
    "shade": [
      17.8,
      4.7,
      1.2
    ]
  },
  "walkup:grey": {
    "sun": [
      35.6,
      14.6,
      13.9
    ],
    "shade": [
      21.2,
      6.7,
      1.2
    ]
  },
  "walkup:navy": {
    "sun": [
      15,
      7,
      4.4
    ],
    "shade": [
      14.4,
      5.5,
      0.6
    ]
  },
  "walkup:cream": {
    "sun": [
      55.9,
      13.3,
      18.7
    ],
    "shade": [
      35.6,
      10.3,
      4.8
    ]
  },
  "commercial:limestone": {
    "sun": [
      31.2,
      10.9,
      10.8
    ],
    "shade": [
      23.8,
      7.3,
      1.7
    ]
  },
  "commercial:white-terracotta": {
    "sun": [
      36.4,
      10.6,
      9.5
    ],
    "shade": [
      29.2,
      8.3,
      0.6
    ]
  },
  "commercial:buff": {
    "sun": [
      28.6,
      13.3,
      15.7
    ],
    "shade": [
      25.3,
      9.2,
      7
    ]
  },
  "commercial:granite": {
    "sun": [
      19.9,
      8.5,
      5.3
    ],
    "shade": [
      21.4,
      7.3,
      0.7
    ]
  },
  "commercial:black": {
    "sun": [
      12.7,
      6.8,
      4.5
    ],
    "shade": [
      19.8,
      7.1,
      2.1
    ]
  },
  "commercial:green-terracotta": {
    "sun": [
      18.5,
      5.1,
      8.5
    ],
    "shade": [
      23.2,
      1.7,
      3.7
    ]
  },
  "commercial:brownstone": {
    "sun": [
      17.2,
      12.3,
      11
    ],
    "shade": [
      21.4,
      4.4,
      4.7
    ]
  },
  "commercial:blue": {
    "sun": [
      23.8,
      9.2,
      6.4
    ],
    "shade": [
      25.3,
      3.8,
      1.1
    ]
  },
  "midcentury:teal": {
    "sun": [
      20.8,
      2.1,
      4.5
    ],
    "shade": [
      15.9,
      1.7,
      1.2
    ]
  },
  "midcentury:enamel": {
    "sun": [
      15.9,
      5.3,
      4.5
    ],
    "shade": [
      14.1,
      3.1,
      2.2
    ]
  },
  "midcentury:white": {
    "sun": [
      38,
      9.3,
      7.8
    ],
    "shade": [
      27.1,
      5.5,
      0.1
    ]
  },
  "midcentury:slate": {
    "sun": [
      15.6,
      5.3,
      1.7
    ],
    "shade": [
      16.5,
      3.7,
      0.7
    ]
  },
  "midcentury:mies": {
    "sun": [
      11.4,
      4.6,
      2.9
    ],
    "shade": [
      16.1,
      3.8,
      2.3
    ]
  },
  "midcentury:olive": {
    "sun": [
      16.3,
      4.7,
      7.4
    ],
    "shade": [
      19.4,
      3.8,
      4.2
    ]
  },
  "midcentury:sky": {
    "sun": [
      22.7,
      5.2,
      0.1
    ],
    "shade": [
      25.2,
      4.7,
      -0.1
    ]
  },
  "glass:silver": {
    "sun": [
      23.3,
      5,
      2.8
    ],
    "shade": [
      31.3,
      6.7,
      4.1
    ]
  },
  "glass:teal": {
    "sun": [
      9.3,
      -1.5,
      0.3
    ],
    "shade": [
      27.7,
      7,
      4.7
    ]
  },
  "glass:blue": {
    "sun": [
      6.1,
      2,
      -3.3
    ],
    "shade": [
      34.7,
      9.1,
      10.8
    ]
  },
  "glass:charcoal": {
    "sun": [
      4.7,
      1.8,
      -0.4
    ],
    "shade": [
      33.3,
      9.8,
      10.4
    ]
  },
  "glass:smoked": {
    "sun": [
      8.8,
      2.5,
      3.7
    ],
    "shade": [
      2.7,
      0.6,
      -0.8
    ]
  },
  "glass:bronze": {
    "sun": [
      12.2,
      5.9,
      7.2
    ],
    "shade": [
      3.8,
      1.7,
      -0.1
    ]
  },
  "glass:white": {
    "sun": [
      28.4,
      5.3,
      6.9
    ],
    "shade": [
      13.1,
      3.5,
      -2.3
    ]
  },
  "brutalist:grey": {
    "sun": [
      36.5,
      13.8,
      14
    ],
    "shade": [
      14.8,
      5.4,
      0
    ]
  },
  "brutalist:cool": {
    "sun": [
      35.1,
      12.7,
      11.3
    ],
    "shade": [
      13,
      5,
      -2.7
    ]
  },
  "brutalist:pale": {
    "sun": [
      50.5,
      14.8,
      17.6
    ],
    "shade": [
      24.4,
      7.4,
      0.6
    ]
  },
  "brutalist:dark": {
    "sun": [
      17.1,
      7.9,
      8.3
    ],
    "shade": [
      3.7,
      2,
      -0.5
    ]
  },
  "brutalist:buff": {
    "sun": [
      40.2,
      17.3,
      22.7
    ],
    "shade": [
      15.6,
      7.1,
      5.3
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
      6,
      -0.9
    ]
  },
  "industrial:red": {
    "sun": [
      17.9,
      22.4,
      14.7
    ],
    "shade": [
      21.1,
      10,
      3.3
    ]
  },
  "industrial:white": {
    "sun": [
      41.2,
      10.6,
      11.5
    ],
    "shade": [
      36.1,
      8.5,
      0.8
    ]
  },
  "industrial:limewash": {
    "sun": [
      56.4,
      9.7,
      12.7
    ],
    "shade": [
      24.1,
      6.8,
      -0.9
    ]
  },
  "industrial:green": {
    "sun": [
      28.9,
      6.1,
      9.7
    ],
    "shade": [
      5.1,
      1.7,
      -0.2
    ]
  },
  "industrial:buff": {
    "sun": [
      44,
      14.2,
      20.8
    ],
    "shade": [
      14.6,
      7,
      6.2
    ]
  },
  "industrial:steel": {
    "sun": [
      31.9,
      11.1,
      11.9
    ],
    "shade": [
      10.3,
      4.6,
      -2.4
    ]
  },
  "industrial:blue": {
    "sun": [
      20.3,
      5.7,
      5.8
    ],
    "shade": [
      6,
      2.4,
      -3
    ]
  }
};

/** The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it. */
export const AMBIENT_INPUTS = 'rows walkup:red=35a0a13ced;walkup:buff=d0b6262e46;walkup:ironspot=2b473aa9cb;walkup:white=d501513a93;walkup:black=a5fa0fedf4;walkup:sage=1e63e57208;walkup:grey=87b27c1091;walkup:navy=824695ec56;walkup:cream=72747b84a4;commercial:limestone=1228a99e19;commercial:white-terracotta=08dd66e4a6;commercial:buff=19c40c6da5;commercial:granite=e0b7ca0b43;commercial:black=175b2aeaf5;commercial:green-terracotta=81d3f7f419;commercial:brownstone=a1c85d699b;commercial:blue=6e1399dccf;midcentury:teal=ec21f7df2a;midcentury:enamel=35ba00cef3;midcentury:white=3d344024bf;midcentury:slate=6c4269a595;midcentury:mies=e783746237;midcentury:olive=58ba38181c;midcentury:sky=b59344293a;glass:silver=5ef66fa5ce;glass:teal=8a158d4bf5;glass:blue=d3b551a0b7;glass:charcoal=26bf339da6;glass:smoked=17612ddb6d;glass:bronze=1464b4c5e8;glass:white=c35ee2133f;brutalist:grey=8792b6c38d;brutalist:cool=aec41d8609;brutalist:pale=d526855a15;brutalist:dark=7dc0d08600;brutalist:buff=cd4c06a1a0;parking:grey=1b5e66072b;parking:pale=5e5fe47a80;parking:dark=361fdefb9e;parking:mesh=7610f68912;industrial:red=bbfd06fd58;industrial:white=17b2f75104;industrial:limewash=b1b0d2b011;industrial:green=386bc07560;industrial:buff=532cffe97b;industrial:steel=e99ea94c24;industrial:blue=f7b737ed4f';
