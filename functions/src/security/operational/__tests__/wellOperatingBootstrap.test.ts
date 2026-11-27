import { buildWbmBootstrapSnapshot } from '../wbmBootstrap';
const base={driverId:'driver',companyId:'liquid-gold',profile:{companyId:'liquid-gold',assignedRoutes:['Test Route']},wellConfig:{Test:{route:'Test Route'}}};
test('bootstrap projects explicit primary grants from same profile without inferring ownership from assignment',()=>{
 const helper=buildWbmBootstrapSnapshot(base);expect(helper.wellOperatingGrant).toMatchObject({version:1,assignedRoutes:['Test Route'],primaryRoutes:[],primaryAllRoutes:false,isViewer:false});
 const owner=buildWbmBootstrapSnapshot({...base,profile:{...base.profile,primaryRoutes:['Test Route'],primaryRouteRevision:2}});expect(owner.wellOperatingGrant.primaryRoutes).toEqual(['Test Route']);expect(owner.wellOperatingGrant.revision).toBe(2);
});
test('malformed lists fail closed and explicit all-routes/viewer flags retain exact booleans',()=>{
 const s=buildWbmBootstrapSnapshot({...base,profile:{...base.profile,primaryRoutes:['Test Route',null],primaryAllRoutes:'true',isViewer:true}});expect(s.wellOperatingGrant.primaryRoutes).toEqual([]);expect(s.wellOperatingGrant.primaryAllRoutes).toBe(false);expect(s.wellOperatingGrant.isViewer).toBe(true);
});
