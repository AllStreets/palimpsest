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
 */
export const RENDERED: Record<string, { sun: [number, number, number]; shade: [number, number, number]; sunLow?: [number, number, number]; shadeLow?: [number, number, number] }> = {
  "stone:limestone": {
    "sun": [
      40.2,
      14,
      12.1
    ],
    "shade": [
      21.3,
      7,
      -2.2
    ],
    "sunLow": [
      35.1,
      12.5,
      9.7
    ],
    "shadeLow": [
      20.4,
      6.8,
      -1
    ]
  },
  "stone:sandstone": {
    "sun": [
      30.9,
      13.9,
      17.5
    ],
    "shade": [
      17.8,
      5.9,
      4.7
    ],
    "sunLow": [
      30,
      12.9,
      15.9
    ],
    "shadeLow": [
      17,
      6.4,
      4.8
    ]
  },
  "stone:pink-granite": {
    "sun": [
      32.1,
      21.6,
      14.9
    ],
    "shade": [
      16.5,
      10.8,
      0.9
    ],
    "sunLow": [
      27.5,
      17.6,
      11.8
    ],
    "shadeLow": [
      16.6,
      10.3,
      1.8
    ]
  },
  "stone:dark-granite": {
    "sun": [
      14.9,
      9.8,
      10.8
    ],
    "shade": [
      3.6,
      2.3,
      0.4
    ],
    "sunLow": [
      16,
      8.4,
      9.3
    ],
    "shadeLow": [
      6,
      3.7,
      0.8
    ]
  },
  "stone:marble": {
    "sun": [
      47.2,
      12.6,
      9
    ],
    "shade": [
      33.2,
      8.1,
      -3.7
    ],
    "sunLow": [
      45,
      11.9,
      9.1
    ],
    "shadeLow": [
      31.4,
      7.7,
      -2.2
    ]
  },
  "stone:travertine": {
    "sun": [
      27,
      17.6,
      19.5
    ],
    "shade": [
      15.3,
      9.1,
      7.7
    ],
    "sunLow": [
      28.3,
      16.3,
      17.8
    ],
    "shadeLow": [
      16.5,
      8.8,
      6.6
    ]
  },
  "brick:red": {
    "sun": [
      19.1,
      12.4,
      12.1
    ],
    "shade": [
      17.5,
      6.6,
      5.7
    ],
    "sunLow": [
      18.7,
      12.1,
      10.9
    ],
    "shadeLow": [
      17.2,
      6.2,
      3.9
    ]
  },
  "brick:cream": {
    "sun": [
      40.7,
      14.6,
      19.3
    ],
    "shade": [
      27.9,
      7,
      4.5
    ],
    "sunLow": [
      39.2,
      14.1,
      17.8
    ],
    "shadeLow": [
      29.9,
      7.5,
      5
    ]
  },
  "brick:ironspot": {
    "sun": [
      16,
      12.4,
      14
    ],
    "shade": [
      5.6,
      5.3,
      2.9
    ],
    "sunLow": [
      18.1,
      11.7,
      12.5
    ],
    "shadeLow": [
      6.9,
      6,
      3.2
    ]
  },
  "brick:terracotta": {
    "sun": [
      44,
      12.8,
      9.6
    ],
    "shade": [
      32.5,
      8.2,
      -3.2
    ],
    "sunLow": [
      43.1,
      12.8,
      9.1
    ],
    "shadeLow": [
      31.2,
      8.1,
      -2.8
    ]
  },
  "brick:green-terracotta": {
    "sun": [
      14,
      3.6,
      7
    ],
    "shade": [
      6.4,
      2.1,
      1.9
    ],
    "sunLow": [
      15.5,
      4,
      6.1
    ],
    "shadeLow": [
      8.9,
      3,
      1.9
    ]
  },
  "brick:salmon": {
    "sun": [
      31.3,
      22.8,
      19.9
    ],
    "shade": [
      20.3,
      13,
      8.4
    ],
    "sunLow": [
      31.2,
      21.8,
      18.6
    ],
    "shadeLow": [
      24.7,
      13.4,
      10.1
    ]
  },
  "glass:green": {
    "sun": [
      30.1,
      -0.8,
      2.6
    ],
    "shade": [
      21.7,
      -1.1,
      -2.1
    ],
    "sunLow": [
      31.1,
      -1,
      0.6
    ],
    "shadeLow": [
      25.3,
      0.1,
      -1.2
    ]
  },
  "glass:bronze": {
    "sun": [
      31.7,
      11.7,
      21.8
    ],
    "shade": [
      21.7,
      13.1,
      17.3
    ],
    "sunLow": [
      30.4,
      11.5,
      20
    ],
    "shadeLow": [
      17.4,
      10.9,
      11.3
    ]
  },
  "glass:blue": {
    "sun": [
      27.2,
      3.5,
      -7.1
    ],
    "shade": [
      31.8,
      5,
      -4.6
    ],
    "sunLow": [
      28.6,
      3.6,
      -9.2
    ],
    "shadeLow": [
      38.3,
      6.6,
      0.4
    ]
  },
  "glass:black": {
    "sun": [
      21.9,
      3.9,
      9
    ],
    "shade": [
      17.1,
      3,
      6
    ],
    "sunLow": [
      29.2,
      4.7,
      11
    ],
    "shadeLow": [
      18.5,
      3.5,
      5.8
    ]
  },
  "glass:channel": {
    "sun": [
      65.2,
      6.9,
      19.9
    ],
    "shade": [
      54.8,
      8.1,
      15.3
    ],
    "sunLow": [
      65.7,
      7,
      20.3
    ],
    "shadeLow": [
      62.2,
      6.6,
      15.8
    ]
  },
  "titanium:titanium": {
    "sun": [
      28.4,
      4.1,
      3.7
    ],
    "shade": [
      25.4,
      9.4,
      -1
    ],
    "sunLow": [
      26.7,
      4.5,
      4.2
    ],
    "shadeLow": [
      24.2,
      9.1,
      -1.9
    ]
  },
  "titanium:zinc": {
    "sun": [
      22.5,
      3,
      -0.8
    ],
    "shade": [
      13.1,
      6.3,
      1.6
    ],
    "sunLow": [
      25.5,
      3,
      -2.5
    ],
    "shadeLow": [
      18,
      7.5,
      2.8
    ]
  },
  "titanium:copper": {
    "sun": [
      8.6,
      4.5,
      5.5
    ],
    "shade": [
      23.8,
      -0.4,
      4.9
    ],
    "sunLow": [
      11.5,
      5,
      5.8
    ],
    "shadeLow": [
      24.1,
      0.2,
      4.4
    ]
  },
  "titanium:bronze": {
    "sun": [
      32.2,
      9,
      19.5
    ],
    "shade": [
      5.7,
      9,
      5.2
    ],
    "sunLow": [
      34.9,
      9.5,
      19.7
    ],
    "shadeLow": [
      8.4,
      10.1,
      6.4
    ]
  },
  "titanium:black": {
    "sun": [
      4,
      2.8,
      2.1
    ],
    "shade": [
      1.8,
      1,
      -0.2
    ],
    "sunLow": [
      6.2,
      4,
      2.1
    ],
    "shadeLow": [
      2.8,
      1.5,
      -0.2
    ]
  },
  "scifi:deco": {
    "sun": [
      29.6,
      7.9,
      8.2
    ],
    "shade": [
      14.5,
      10.3,
      5.6
    ],
    "sunLow": [
      28.4,
      7.6,
      6.8
    ],
    "shadeLow": [
      15.5,
      9.9,
      5.1
    ]
  },
  "scifi:ziggurat": {
    "sun": [
      12.9,
      7.6,
      9.8
    ],
    "shade": [
      20.7,
      6.9,
      3.3
    ],
    "sunLow": [
      16,
      7.6,
      9.5
    ],
    "shadeLow": [
      17.3,
      6.9,
      3.9
    ]
  },
  "scifi:needle": {
    "sun": [
      35.7,
      3.8,
      -10.6
    ],
    "shade": [
      19.1,
      7.2,
      2.8
    ],
    "sunLow": [
      32.2,
      4.1,
      -11.2
    ],
    "shadeLow": [
      11.4,
      6.1,
      -0.2
    ]
  },
  "scifi:arcology": {
    "sun": [
      31.7,
      11.2,
      14
    ],
    "shade": [
      23.7,
      10.9,
      6.7
    ],
    "sunLow": [
      30.3,
      9.9,
      13.2
    ],
    "shadeLow": [
      20.6,
      8.9,
      6.9
    ]
  },
  "scifi:organic": {
    "sun": [
      20.6,
      4.9,
      -2.6
    ],
    "shade": [
      25.4,
      7.3,
      0.5
    ],
    "sunLow": [
      26,
      5.7,
      -1.4
    ],
    "shadeLow": [
      20.7,
      7.8,
      2.2
    ]
  },
  "scifi:cluster": {
    "sun": [
      28,
      2.9,
      -7.1
    ],
    "shade": [
      25.3,
      8.2,
      3.3
    ],
    "sunLow": [
      27.8,
      2.9,
      -7.9
    ],
    "shadeLow": [
      17.8,
      6.7,
      4.7
    ]
  }
};

/** The fingerprint of what this table was measured from (tools/measure-inputs.ts); test/measured.test.ts compares it. */
export const RENDERED_INPUTS = 'rows stone:limestone=2d79cc5995;stone:sandstone=1abdcbd5b8;stone:pink-granite=ea1b1612b7;stone:dark-granite=0a3457706e;stone:marble=1ac28191d1;stone:travertine=1ef303a7db;brick:red=77af310bd9;brick:cream=32c948ce28;brick:ironspot=11685ce031;brick:terracotta=1e5c724a96;brick:green-terracotta=6553c7bba2;brick:salmon=ff4c8ea790;glass:green=84a37e73fb;glass:bronze=172b307abb;glass:blue=962e3434c5;glass:black=d0d56f9bde;glass:channel=2db391601c;titanium:titanium=a2cafdffed;titanium:zinc=315524998d;titanium:copper=2d845b9b32;titanium:bronze=c26f94ba51;titanium:black=a1cecb801b;scifi:deco=5c68c92d01;scifi:ziggurat=71ad272b4e;scifi:needle=be11129195;scifi:arcology=628919293c;scifi:organic=99031ed3a4;scifi:cluster=c4ca98e289';
