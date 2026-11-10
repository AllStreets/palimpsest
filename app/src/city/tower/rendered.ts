/**
 * Each variant's colour as the city renders it at the overview's distance
 * and bearing (CIE Lab of the sunlit and the shaded face), measured by
 * tools/capture.ts, the swatches shot. Generated: re-run
 * `SWATCH_WRITE=1 node --import tsx tools/capture.ts swatches` after a
 * material, light or post change. The picker steers neighbours apart by it.
 */
export const RENDERED: Record<string, { sun: [number, number, number]; shade: [number, number, number] }> = {
  "stone:limestone": {
    "sun": [
      49.3,
      12.9,
      10.4
    ],
    "shade": [
      40.6,
      10.7,
      3.7
    ]
  },
  "stone:sandstone": {
    "sun": [
      48.7,
      12,
      14.2
    ],
    "shade": [
      41.7,
      10,
      8.4
    ]
  },
  "stone:pink-granite": {
    "sun": [
      45.7,
      15.8,
      10.3
    ],
    "shade": [
      39.7,
      13,
      4.2
    ]
  },
  "stone:dark-granite": {
    "sun": [
      39.5,
      11.3,
      8.7
    ],
    "shade": [
      36.1,
      10.4,
      5.3
    ]
  },
  "stone:marble": {
    "sun": [
      56.8,
      12.3,
      8.7
    ],
    "shade": [
      49.6,
      11,
      1.9
    ]
  },
  "stone:travertine": {
    "sun": [
      41.1,
      14.2,
      10.6
    ],
    "shade": [
      38,
      12.5,
      7.7
    ]
  },
  "brick:red": {
    "sun": [
      38.4,
      12.8,
      8.5
    ],
    "shade": [
      38,
      10.9,
      6.1
    ]
  },
  "brick:cream": {
    "sun": [
      50.7,
      13.5,
      16.4
    ],
    "shade": [
      44.3,
      10.1,
      8.1
    ]
  },
  "brick:ironspot": {
    "sun": [
      39.8,
      12.9,
      10.7
    ],
    "shade": [
      33.2,
      11.1,
      5.8
    ]
  },
  "brick:terracotta": {
    "sun": [
      54.4,
      12,
      7.7
    ],
    "shade": [
      50,
      11.3,
      2.5
    ]
  },
  "brick:green-terracotta": {
    "sun": [
      37.7,
      9.7,
      7.2
    ],
    "shade": [
      36.8,
      9.9,
      5.1
    ]
  },
  "brick:salmon": {
    "sun": [
      47.1,
      18.5,
      15.2
    ],
    "shade": [
      41.4,
      15.2,
      9.5
    ]
  },
  "glass:green": {
    "sun": [
      42.7,
      6,
      3.2
    ],
    "shade": [
      43.4,
      8.4,
      5.2
    ]
  },
  "glass:bronze": {
    "sun": [
      40.8,
      12.9,
      13.2
    ],
    "shade": [
      44.7,
      13.2,
      15.3
    ]
  },
  "glass:blue": {
    "sun": [
      46.1,
      8.3,
      -1.3
    ],
    "shade": [
      45.1,
      8.2,
      -0.9
    ]
  },
  "glass:black": {
    "sun": [
      41.1,
      9.1,
      9.5
    ],
    "shade": [
      43.6,
      8.4,
      9.3
    ]
  },
  "glass:channel": {
    "sun": [
      64,
      8.5,
      16.3
    ],
    "shade": [
      60.3,
      8.5,
      13.4
    ]
  },
  "titanium:titanium": {
    "sun": [
      41.4,
      9.4,
      4.4
    ],
    "shade": [
      46.6,
      10.9,
      6.7
    ]
  },
  "titanium:zinc": {
    "sun": [
      37.3,
      9.9,
      4.4
    ],
    "shade": [
      36.4,
      10.1,
      4.3
    ]
  },
  "titanium:copper": {
    "sun": [
      34.8,
      8.8,
      4.8
    ],
    "shade": [
      39.4,
      6.5,
      5.5
    ]
  },
  "titanium:bronze": {
    "sun": [
      43.5,
      11.9,
      13.3
    ],
    "shade": [
      35.5,
      13.4,
      8.8
    ]
  },
  "titanium:black": {
    "sun": [
      30.6,
      10,
      5.2
    ],
    "shade": [
      29.4,
      9.9,
      4.6
    ]
  },
  "scifi:graphite": {
    "sun": [
      42.6,
      9.5,
      5.8
    ],
    "shade": [
      40.3,
      10.1,
      0.2
    ]
  },
  "scifi:ceramic": {
    "sun": [
      45.3,
      11.8,
      8.2
    ],
    "shade": [
      48.6,
      11.4,
      2.9
    ]
  },
  "scifi:carbon": {
    "sun": [
      43.1,
      7.2,
      -2
    ],
    "shade": [
      34,
      9.8,
      2.2
    ]
  },
  "scifi:pearl": {
    "sun": [
      47.8,
      8.8,
      1.2
    ],
    "shade": [
      43.4,
      11,
      -1.9
    ]
  }
};
