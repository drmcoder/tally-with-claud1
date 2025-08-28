const { add, multiply, isEven } = require('./utils');

describe('Utils functions', () => {
  describe('add function', () => {
    test('should add two positive numbers', () => {
      expect(add(2, 3)).toBe(5);
    });

    test('should add negative numbers', () => {
      expect(add(-2, -3)).toBe(-5);
    });

    test('should add positive and negative numbers', () => {
      expect(add(5, -3)).toBe(2);
    });
  });

  describe('multiply function', () => {
    test('should multiply two positive numbers', () => {
      expect(multiply(3, 4)).toBe(12);
    });

    test('should multiply by zero', () => {
      expect(multiply(5, 0)).toBe(0);
    });

    test('should multiply negative numbers', () => {
      expect(multiply(-2, 3)).toBe(-6);
    });
  });

  describe('isEven function', () => {
    test('should return true for even numbers', () => {
      expect(isEven(4)).toBe(true);
      expect(isEven(0)).toBe(true);
    });

    test('should return false for odd numbers', () => {
      expect(isEven(3)).toBe(false);
      expect(isEven(7)).toBe(false);
    });

    test('should handle negative numbers', () => {
      expect(isEven(-2)).toBe(true);
      expect(isEven(-3)).toBe(false);
    });
  });
});