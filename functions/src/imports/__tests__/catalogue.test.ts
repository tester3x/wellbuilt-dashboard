import { parsePullChat } from '../pullParser';
test('recognizes any configured catalogue name', () => {
  const [row] = parsePullChat('[9/20/26, 3:41:19 PM] Driver: Tornado 1\nTop: 8.2\nBottom: 7.2\n185 bbls', {wellNames:['Tornado 1']});
  expect(row.wellName).toBe('Tornado 1');
});
import { parsePullChat } from '../pullParser';
test('no-space well separator is not swallowed as an NDIC suffix with catalogue names',()=>{
 const [row]=parsePullChat('[9/20/26, 3:41 PM] Driver: Kahuna 5-8.3/7.4\n165 bbls',{wellNames:['Kahuna 5']});expect(row.tankLevelFeet).toBe(8.3);expect(row.bblsTaken).toBe(165);
});
