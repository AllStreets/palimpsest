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
      10.1
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
export const AMBIENT_INPUTS = 'rows walkup:red=7e3cace46d;walkup:buff=1b9b2bda0c;walkup:ironspot=fb7ef7e3bd;walkup:white=7faef75193;walkup:black=68e738d726;walkup:sage=1c1a1fd899;walkup:grey=6dc0a379f6;walkup:navy=ba61c09ae4;walkup:cream=ba05af6292;commercial:limestone=323685ec67;commercial:white-terracotta=dc6fff0b20;commercial:buff=b62d65b915;commercial:granite=d7a5dd724d;commercial:black=0c8e6c4bca;commercial:green-terracotta=fdebb0020a;commercial:brownstone=67fabc070b;commercial:blue=ac604e996b;midcentury:teal=7fb564e0fd;midcentury:enamel=8b63af9dd2;midcentury:white=e44ba98f03;midcentury:slate=af641bb31f;midcentury:mies=ad47c3983b;midcentury:olive=ae5ad9f501;midcentury:sky=d82bc84484;glass:silver=6b9275d03c;glass:teal=949fd7c0f8;glass:blue=a878bb279b;glass:charcoal=a273d71d1b;glass:smoked=1e98ddebc4;glass:bronze=f5f5d4f172;glass:white=5935650eb1;brutalist:grey=47dc1e2017;brutalist:cool=d00916fe69;brutalist:pale=5e70d59501;brutalist:dark=08e1aaee14;brutalist:buff=4fa8055e35;parking:grey=d7ba0591a6;parking:pale=b8d93da404;parking:dark=44ab82952a;parking:mesh=67bb44bc4d;industrial:red=c0f8bd49ca;industrial:white=b53509965d;industrial:limewash=22257eb155;industrial:green=cc353db609;industrial:buff=49f04edd12;industrial:steel=508af5ca5c;industrial:blue=d667c46502';
