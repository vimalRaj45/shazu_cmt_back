require('dotenv').config();
const { fetchOrcidProfile } = require('../src/services/orcidService');
const { generateAiAutoAssignmentPlan } = require('../src/services/aiAssignService');
const db = require('../src/config/db');

async function testAll() {
  console.log('=== 1. Testing ORCID Public API Integration ===');
  try {
    // Testing with a famous public ORCID iD
    const sampleOrcid = '0000-0002-1825-0097';
    console.log(`Fetching public profile for ORCID: ${sampleOrcid}...`);
    const profile = await fetchOrcidProfile(sampleOrcid);
    console.log('✅ ORCID Profile Retrieved:');
    console.log(`- Name: ${profile.firstName} ${profile.lastName}`);
    console.log(`- Institution: ${profile.institution || 'N/A'}`);
    console.log(`- Department: ${profile.department || 'N/A'}`);
    console.log(`- Inferred Domain: ${profile.domain}`);
    console.log(`- Areas of Interest: ${profile.areasOfInterest.join(', ')}`);
  } catch (err) {
    console.error('❌ ORCID fetch test error:', err.message);
  }

  console.log('\n=== 2. Testing Mistral AI Auto-Assignment Engine ===');
  try {
    const confs = await db.query('SELECT id, name FROM conferences ORDER BY id DESC LIMIT 1');
    if (confs.rows.length > 0) {
      const confId = confs.rows[0].id;
      console.log(`Running Mistral AI auto-assignment simulation for conference ${confId}...`);
      const plan = await generateAiAutoAssignmentPlan(confId, {
        targetReviewsPerPaper: 2,
        maxReviewsPerReviewer: 3,
        onlyUnassigned: false,
      });

      console.log('✅ Mistral AI Auto-Assignment Plan Result:');
      console.log(`- Total submissions evaluated: ${plan.totalSubmissionsEvaluated}`);
      console.log(`- Total proposed assignments: ${plan.totalNewAssignments}`);
      console.log(`- Reviewer pool size: ${plan.reviewerPoolSize}`);

      if (plan.plan.length > 0) {
        const first = plan.plan[0];
        console.log(`\nSample Proposed Match for Paper #${first.submissionNumber}: "${first.title.slice(0, 50)}..."`);
        first.proposedReviewers.forEach((r) => {
          console.log(`  -> Reviewer: ${r.reviewerName} | Score: ${r.matchScore}% (${r.confidence})`);
          console.log(`     AI Rationale: ${r.aiRationale}`);
        });
      }
    }
  } catch (err) {
    console.error('❌ Mistral AI test error:', err.message);
  } finally {
    await db.pool.end();
  }
}

testAll();
