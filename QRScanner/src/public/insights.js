// insights.js - Business Insights Query Interface

// API URL - call Lambda directly
const API_URL = window.INDIETIX_API_URL;

// Initialize page
document.addEventListener('DOMContentLoaded', function() {
    const insightsForm = document.getElementById('insights-form');
    const questionInput = document.getElementById('question-input');
    const askBtn = document.getElementById('ask-btn');
    const resultsSection = document.getElementById('results-section');
    const resultsContent = document.getElementById('results-content');
    const errorMessage = document.getElementById('error-message');
    const clearResultsBtn = document.getElementById('clear-results');
    
    // Example question buttons
    const exampleButtons = document.querySelectorAll('.example-btn');
    exampleButtons.forEach(button => {
        button.addEventListener('click', function() {
            const question = this.getAttribute('data-question');
            questionInput.value = question;
            questionInput.focus();
        });
    });
    
    // Form submission
    insightsForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const question = questionInput.value.trim();
        if (!question) {
            showError('Please enter a question');
            return;
        }
        
        // Clear previous results/errors
        hideError();
        hideResults();
        
        // Set loading state
        setLoading(true);
        
        try {
            const response = await fetch(`${API_URL}/api/insights/query`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ question })
            });
            
            // Log response for debugging
            console.log('Response status:', response.status);
            
            // Get response text first to see what we're getting
            const responseText = await response.text();
            console.log('Response body:', responseText.substring(0, 500));
            
            // Try to parse as JSON
            let data;
            try {
                data = JSON.parse(responseText);
            } catch (parseError) {
                console.error('Failed to parse response as JSON:', parseError);
                throw new Error('Server returned invalid response. Check console for details.');
            }
            
            if (!response.ok) {
                throw new Error(data.error || 'Failed to get insights');
            }
            
            // Display results
            displayResults(data.answer, question, data.sql);
            
        } catch (error) {
            console.error('Error getting insights:', error);
            showError(error.message || 'Failed to get insights. Please try again.');
        } finally {
            setLoading(false);
        }
    });
    
    // Clear results button
    clearResultsBtn.addEventListener('click', function() {
        hideResults();
        questionInput.value = '';
        questionInput.focus();
    });
});

/**
 * Display results in the results section
 */
function displayResults(answer, question, sql) {
    console.log('[Display] Called with:', { answer: answer?.substring(0, 50), question, sql: sql?.substring(0, 100) });
    
    const resultsSection = document.getElementById('results-section');
    const resultsContent = document.getElementById('results-content');
    const sqlSection = document.getElementById('sql-section');
    const sqlQuery = document.getElementById('sql-query');
    const toggleSqlBtn = document.getElementById('toggle-sql');
    
    console.log('[Display] Elements found:', {
        resultsSection: !!resultsSection,
        resultsContent: !!resultsContent,
        sqlSection: !!sqlSection,
        sqlQuery: !!sqlQuery,
        toggleSqlBtn: !!toggleSqlBtn
    });
    
    // Check if required elements exist
    if (!resultsSection || !resultsContent) {
        console.error('Required result elements not found');
        return;
    }
    
    // Format the answer (convert markdown-style formatting to HTML)
    let formattedAnswer = answer
        // Convert **bold** to <strong>
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Convert line breaks to paragraphs
        .split('\n\n')
        .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
        .join('');
    
    // Add question context
    resultsContent.innerHTML = `
        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
            <strong style="color: #666; font-size: 13px; text-transform: uppercase;">Question:</strong>
            <p style="margin: 5px 0 0 0; color: #333;">${escapeHtml(question)}</p>
        </div>
        ${formattedAnswer}
    `;
    
    // Show SQL query section if elements exist
    console.log('[Display] Checking SQL condition:', {
        hasSql: !!sql,
        hasSqlSection: !!sqlSection,
        hasSqlQuery: !!sqlQuery,
        hasToggleBtn: !!toggleSqlBtn
    });
    
    if (sql && sqlSection && sqlQuery && toggleSqlBtn) {
        console.log('[Display] Attempting to display SQL...');
        const codeElement = sqlQuery.querySelector('code');
        console.log('[Display] Code element found:', !!codeElement);
        
        if (codeElement) {
            codeElement.textContent = sql;
            console.log('[Display] SQL set in code element');
        }
        sqlSection.style.display = 'block';
        console.log('[Display] SQL section display set to block');
        
        // Reset toggle button
        const toggleSpan = toggleSqlBtn.querySelector('span');
        if (toggleSpan) {
            toggleSpan.textContent = 'Show SQL Query';
        }
        sqlQuery.style.display = 'none';
        
        // Toggle SQL visibility
        toggleSqlBtn.onclick = function() {
            console.log('[Display] Toggle clicked, current display:', sqlQuery.style.display);
            if (sqlQuery.style.display === 'none') {
                sqlQuery.style.display = 'block';
                if (toggleSpan) toggleSpan.textContent = 'Hide SQL Query';
            } else {
                sqlQuery.style.display = 'none';
                if (toggleSpan) toggleSpan.textContent = 'Show SQL Query';
            }
        };
        console.log('[Display] SQL section setup complete');
    } else {
        console.log('[Display] SQL section NOT displayed - missing:', {
            sql: !sql ? 'SQL is missing/falsy' : 'SQL exists',
            sqlSection: !sqlSection ? 'sqlSection element missing' : 'sqlSection exists',
            sqlQuery: !sqlQuery ? 'sqlQuery element missing' : 'sqlQuery exists',
            toggleSqlBtn: !toggleSqlBtn ? 'toggleSqlBtn element missing' : 'toggleSqlBtn exists'
        });
    }
    
    resultsSection.style.display = 'block';
    console.log('[Display] Results section displayed');
}

/**
 * Show error message
 */
function showError(message) {
    const errorDiv = document.getElementById('error-message');
    if (!errorDiv) return;
    
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    // Auto-hide after 8 seconds
    setTimeout(() => {
        hideError();
    }, 8000);
}

/**
 * Hide error message
 */
function hideError() {
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
        errorDiv.style.display = 'none';
    }
}

/**
 * Hide results section
 */
function hideResults() {
    const resultsSection = document.getElementById('results-section');
    const sqlSection = document.getElementById('sql-section');
    
    if (resultsSection) {
        resultsSection.style.display = 'none';
    }
    if (sqlSection) {
        sqlSection.style.display = 'none';
    }
}

/**
 * Set loading state
 */
function setLoading(isLoading) {
    const askBtn = document.getElementById('ask-btn');
    const btnText = askBtn.querySelector('.btn-text');
    const btnLoading = askBtn.querySelector('.btn-loading');
    
    askBtn.disabled = isLoading;
    
    if (isLoading) {
        btnText.style.display = 'none';
        btnLoading.style.display = 'inline-flex';
    } else {
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
