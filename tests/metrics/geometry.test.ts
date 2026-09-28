import { expect, test } from 'vitest';
import { hausdorff, hausdorffMeters, lengthRecallPrecision } from './geometry';

test('Hausdorff measures segments, offsets, interiors and empty sets', () => {
  expect(
    hausdorff(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 3],
        [10, 3],
      ],
    ),
  ).toBe(3);
  expect(
    hausdorff(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 0],
        [2, 0],
        [10, 0],
      ],
    ),
  ).toBe(0);
  expect(
    hausdorff(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 0],
        [0, 4],
        [10, 4],
        [10, 0],
      ],
    ),
  ).toBe(4);
  expect(hausdorff([[0, 0]], [[3, 4]])).toBe(5);
  expect(hausdorff([], [])).toBe(0);
  expect(hausdorff([], [[0, 0]])).toBe(Infinity);
  expect(() => hausdorff([], [], 0)).toThrow();
});
test('meter metric has known equatorial scale and crosses dateline', () => {
  expect(hausdorffMeters([[0, 0]], [[0.001, 0]])).toBeCloseTo(111.19508, 4);
  expect(hausdorffMeters([[0, 179.999]], [[0, -179.999]])).toBeCloseTo(222.39016, 4);
});
test('recall weights length, not number of lines or vertices', () => {
  expect(
    lengthRecallPrecision(
      [
        [
          [0, 0],
          [5, 0],
        ],
      ],
      [
        [
          [0, 0],
          [10, 0],
        ],
      ],
      0,
    ),
  ).toEqual({ recall: 0.5, precision: 1 });
  expect(
    lengthRecallPrecision(
      [
        [
          [0, 0],
          [10, 0],
        ],
        [
          [0, 20],
          [30, 20],
        ],
      ],
      [
        [
          [0, 0],
          [10, 0],
        ],
      ],
      0,
    ),
  ).toEqual({ recall: 1, precision: 0.25 });
  expect(
    lengthRecallPrecision(
      [
        [
          [0, 0],
          [2, 0],
        ],
        [
          [8, 0],
          [10, 0],
        ],
      ],
      [
        [
          [0, 0],
          [10, 0],
        ],
      ],
      1,
    ),
  ).toEqual({ recall: expect.closeTo(0.6, 12), precision: 1 });
});
test('capsule union handles crossings, overlaps and tolerance boundaries', () => {
  const line = [
    [
      [-5, 0],
      [5, 0],
    ],
  ] as const;
  expect(
    lengthRecallPrecision(
      [
        [
          [0, -5],
          [0, 5],
        ],
      ],
      line,
      1,
    ),
  ).toEqual({ recall: expect.closeTo(0.2, 12), precision: expect.closeTo(0.2, 12) });
  expect(lengthRecallPrecision([...line, ...line], line, 1)).toEqual({ recall: 1, precision: 1 });
  expect(
    lengthRecallPrecision(
      [
        [
          [0, 3],
          [10, 3],
        ],
      ],
      [
        [
          [0, 0],
          [10, 0],
        ],
      ],
      3,
    ),
  ).toEqual({ recall: 1, precision: 1 });
  expect(lengthRecallPrecision([], line, 0)).toEqual({ recall: 0, precision: 1 });
  expect(lengthRecallPrecision([], [], 0)).toEqual({ recall: 1, precision: 1 });
  expect(() => lengthRecallPrecision([], [], -1)).toThrow();
});
