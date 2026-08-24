const db = require('../src/config/db');
const { generateAiAutoAssignmentPlan } = require('../src/services/aiAssignService');

async function testAi() {
  try {
    const confs = await db.query('SELECT id, name FROM conferences ORDER BY id DESC LIMIT 1');
    if (confs.rows.length === 0) {
      console.log('No conferences found to test.');
      return;
    }
    const confId = confs.rows[0].id;
    console.log(`Testing AI Auto-Assignment for conference: ${confs.rows[0].name} (ID: ${confId})`);
    
    const result = await generateAiAutoAssignmentPlan(confId, {
      targetReviewsPerPaper: 2,
      maxReviewsPerReviewer: 3,
      onlyUnassigned: false,
    });

    console.log('AI Assignment Result:');
    console.log(`- Submissions evaluated: ${result.totalSubmissionsEvaluated}`);
    console.log(`- Total new assignments planned: ${result.totalNewAssignments}`);
    console.log(`- Reviewer pool size: ${result.reviewerPoolSize}`);
    console.log(`- Warnings:`, result.warnings);
    
    if (result.plan.length > 0) {
      console.log('\nSample Paper Assignment Plan:');
      const first = result.plan[0];
      console.log(`Paper #${first.submissionNumber}: "${first.title}" (Track: ${first.trackName})`);
      first.proposedReviewers.forEach((pr) => {
        console.log(`  -> Reviewer: ${pr.reviewerName} | Match: ${pr.matchScore}% (${pr.confidence})`);
        console.log(`     Rationale: ${pr.aiRationale}`);
        console.log(`     Matched Topics: ${pr.matchedTopics.join(', ') || 'Domain match'}`);
      });
    }
    console.log('\n✅ AI Auto-Assignment Engine test PASSED!');
  } catch (err) {
    console.error('❌ Test failed:', err);
  } finally {
    await db.pool.end();
  }
}

testAi();
