-- Shazu Soft Technologies Conference Management Tool (CMT) Database Schema

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    institution VARCHAR(255),
    department VARCHAR(255),
    country VARCHAR(100) DEFAULT 'India',
    role VARCHAR(50) NOT NULL DEFAULT 'author' CHECK (role IN ('admin', 'reviewer', 'author')),
    qualification VARCHAR(100),
    designation VARCHAR(150),
    domain VARCHAR(150),
    areas_of_interest TEXT[] DEFAULT '{}',
    expertise_keywords TEXT[] DEFAULT '{}',
    max_review_limit INTEGER DEFAULT 3,
    orcid_id VARCHAR(50),
    google_scholar_url TEXT,
    bio TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Conferences Table
CREATE TABLE IF NOT EXISTS conferences (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(50) NOT NULL,
    description TEXT,
    venue VARCHAR(255),
    logo_url TEXT,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    submission_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    review_deadline TIMESTAMP WITH TIME ZONE,
    decision_date TIMESTAMP WITH TIME ZONE,
    camera_ready_deadline TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'submission_closed', 'under_review', 'decision_phase', 'camera_ready', 'completed')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Conference Chairs (Junction Table for multi-chair conferences)
CREATE TABLE IF NOT EXISTS conference_chairs (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conference_id, user_id)
);

-- 4. Tracks Table
CREATE TABLE IF NOT EXISTS tracks (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    submission_deadline TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Submissions Table
CREATE TABLE IF NOT EXISTS submissions (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
    submission_number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(300) NOT NULL,
    abstract TEXT NOT NULL,
    keywords TEXT[] DEFAULT '{}',
    corresponding_author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'submitted' CHECK (status IN ('draft', 'submitted', 'under_review', 'revision_required', 'accepted', 'rejected', 'camera_ready_pending', 'camera_ready_approved')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Submission Authors (Multi-author support)
CREATE TABLE IF NOT EXISTS submission_authors (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(255) NOT NULL,
    institution VARCHAR(255),
    department VARCHAR(255),
    country VARCHAR(100),
    is_primary BOOLEAN DEFAULT FALSE,
    is_corresponding BOOLEAN DEFAULT FALSE,
    author_order INTEGER DEFAULT 1
);

-- 7. Submission Files (Cloudflare R2 storage records)
CREATE TABLE IF NOT EXISTS submission_files (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    file_type VARCHAR(50) NOT NULL CHECK (file_type IN ('manuscript', 'supplementary', 'revision', 'camera_ready', 'presentation')),
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100),
    s3_key TEXT NOT NULL,
    public_url TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Reviewer Conference Invitations
CREATE TABLE IF NOT EXISTS conference_reviewers (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'accepted' CHECK (status IN ('invited', 'accepted', 'declined')),
    invited_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(conference_id, reviewer_id)
);

-- 9. Reviewer Assignments
CREATE TABLE IF NOT EXISTS reviewer_assignments (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    invitation_status VARCHAR(50) DEFAULT 'accepted' CHECK (invitation_status IN ('invited', 'accepted', 'declined')),
    UNIQUE(submission_id, reviewer_id)
);

-- 10. Conflict Management
CREATE TABLE IF NOT EXISTS conflicts (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
    conflict_type VARCHAR(50) NOT NULL CHECK (conflict_type IN ('same_institution', 'coauthor', 'personal', 'manual')),
    notes TEXT,
    declared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 11. Reviews Table
CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    technical_quality INTEGER CHECK (technical_quality BETWEEN 1 AND 5),
    originality INTEGER CHECK (originality BETWEEN 1 AND 5),
    relevance INTEGER CHECK (relevance BETWEEN 1 AND 5),
    presentation_quality INTEGER CHECK (presentation_quality BETWEEN 1 AND 5),
    overall_score INTEGER CHECK (overall_score BETWEEN 1 AND 5),
    recommendation VARCHAR(50) CHECK (recommendation IN ('accept', 'minor_revision', 'major_revision', 'reject')),
    comments_for_authors TEXT,
    confidential_chair_notes TEXT,
    is_draft BOOLEAN DEFAULT TRUE,
    submitted_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(submission_id, reviewer_id)
);

-- 12. Paper Decisions
CREATE TABLE IF NOT EXISTS paper_decisions (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER UNIQUE NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    decision VARCHAR(50) NOT NULL CHECK (decision IN ('accept', 'reject', 'revision_required')),
    decision_notes TEXT,
    notified_authors BOOLEAN DEFAULT FALSE,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 13. Conference Sessions
CREATE TABLE IF NOT EXISTS conference_sessions (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
    session_name VARCHAR(200) NOT NULL,
    session_chair_name VARCHAR(150),
    venue_room VARCHAR(150),
    session_date DATE NOT NULL,
    start_time VARCHAR(20) NOT NULL,
    end_time VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 14. Session Presentations (Ordering of papers within a session)
CREATE TABLE IF NOT EXISTS session_presentations (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES conference_sessions(id) ON DELETE CASCADE,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    presentation_order INTEGER DEFAULT 1,
    start_time VARCHAR(20),
    end_time VARCHAR(20),
    presentation_notes TEXT,
    UNIQUE(session_id, submission_id)
);

-- 15. Announcements
CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    target_role VARCHAR(50) DEFAULT 'all' CHECK (target_role IN ('all', 'authors', 'reviewers', 'participants')),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 16. Email Logs
CREATE TABLE IF NOT EXISTS email_logs (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER REFERENCES conferences(id) ON DELETE SET NULL,
    recipient_email VARCHAR(255) NOT NULL,
    recipient_name VARCHAR(150),
    subject VARCHAR(255) NOT NULL,
    template_name VARCHAR(100),
    content_preview TEXT,
    status VARCHAR(50) DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
    brevo_message_id VARCHAR(255),
    error_message TEXT,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 17. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    conference_id INTEGER REFERENCES conferences(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100),
    entity_id VARCHAR(100),
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indices for rapid querying
CREATE INDEX IF NOT EXISTS idx_submissions_conf ON submissions(conference_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_author ON submissions(corresponding_author_id);
CREATE INDEX IF NOT EXISTS idx_reviewer_assign_sub ON reviewer_assignments(submission_id);
CREATE INDEX IF NOT EXISTS idx_reviewer_assign_rev ON reviewer_assignments(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_sub ON reviews(submission_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_conf ON audit_logs(conference_id);
