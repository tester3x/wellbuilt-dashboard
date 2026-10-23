import { ndicCatalogDestination } from '../ndicCatalogClassification';
describe('NDIC work location classification', () => {
  test.each([
    ['A', 'OG', 'wells'], ['IA', 'OG', 'wells_inactive'],
    ['A', 'SWD', 'disposals'], ['A', 'WI', 'disposals'],
    ['Confidential', 'Confidential', 'wells'],
    [' confidential ', ' confidential ', 'wells'],
    ['IA', 'SWD', null], ['P', 'unknown', null], ['', '', null],
    ['Confidential', 'SWD', null],
  ])('%s / %s maps to %s', (status, type, expected) => {
    expect(ndicCatalogDestination(status, type)).toBe(expected);
  });
});
