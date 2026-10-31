document.addEventListener('DOMContentLoaded', function() {
  const html5QrCode = new Html5Qrcode("reader");
  const resultContainer = document.getElementById("result-text");
  const apiStatus = document.getElementById("api-status");
  const actionContainer = document.getElementById("action-container");
  const userInfo = document.getElementById("user-info");
  const API_URL = window.INDIETIX_API_URL;
  let lastScannedCode = null;
  
  // Display username if available
  const urlParams = new URLSearchParams(window.location.search);
  const username = urlParams.get('username');
  if (username) {
    userInfo.textContent = `Logged in as: ${username}`;
    userInfo.style.display = 'block';
  }
  
  // Add logout button
  const logoutButton = document.createElement("button");
  logoutButton.textContent = "Logout";
  logoutButton.className = "logout-button";
  logoutButton.onclick = logout;
  document.querySelector('.footer').appendChild(logoutButton);
  
  function getAuthHeaders() {
    const token = localStorage.getItem('authToken');
    return {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : ''
    };
  }

  function logout() {
    fetch(`${API_URL}/api/logout`, {headers: getAuthHeaders()})
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          window.location.href = 'login.html';
        }
      })
      .catch(error => {
        console.error('Logout error:', error);
      });
  }
  
  // Check if the Lambda API is accessible
  fetch(`${API_URL}/api/health`, {
    headers: getAuthHeaders()
  })
    .then(response => response.json())
    .then(data => {
      apiStatus.textContent = `API Status: Connected (${data.timestamp})`;
      apiStatus.style.color = 'green';
    })
    .catch(error => {
      apiStatus.textContent = `API Status: Error (${error.message})`;
      apiStatus.style.color = 'red';
    });
  
  const qrCodeSuccessCallback = (decodedText, decodedResult) => {
    // Stop scanning once we get a result
    html5QrCode.stop();
    
    // Store the scanned code
    lastScannedCode = decodedText;
    
    // Display the result
    resultContainer.textContent = decodedText;
    resultContainer.style.color = "#007bff";
    
    // Clear any previous action buttons
    actionContainer.innerHTML = '';
    
    // Add a check-in button
    const checkInButton = document.createElement("button");
    checkInButton.textContent = "Check-in";
    checkInButton.className = "action-button check-in-button";
    checkInButton.onclick = performCheckIn;
    actionContainer.appendChild(checkInButton);
    
    // Add a restart button
    const restartButton = document.createElement("button");
    restartButton.textContent = "Scan Again";
    restartButton.className = "action-button restart-button";
    restartButton.onclick = startScanner;
    actionContainer.appendChild(restartButton);
  };
  
  const performCheckIn = () => {
    if (!lastScannedCode) {
      displayMessage("No QR code scanned yet", "error");
      return;
    }
    
    // Show loading state
    const statusElement = document.getElementById("check-in-status") || createStatusElement();
    statusElement.textContent = "Processing check-in...";
    statusElement.className = "status-message loading";
    
    // Call the API to check in the code
    fetch(`${API_URL}/api/checkin`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ qrCode: lastScannedCode }),
      redirect: 'manual'
    })
    .then(response => {
      if (response.type === 'opaqueredirect') {
        // Session likely expired, redirect to login
        window.location.href = 'login.html';
        throw new Error('Session expired. Redirecting to login.');
      }
      if (!response.ok) {
        throw new Error('Network response was not ok'+JSON.stringify(response));
      }
      return response.json();
    })
    .then(data => {
      // Handle different response statuses
      switch(data.returnStatus) {
        case 'successful_checkin':
          let msg = "Successfully checked in!";
          if (data.productName && data.location) {
            msg = `Checked in: ${data.productName} @ ${data.location}`;
          } else if (data.location) {
            msg = `Successfully checked in! Location: ${data.location}`;
          }
          displayMessage(msg, "success");
        break;
        case 'failed_no_QRCode':
          displayMessage("QR code not found in the system", "error");
          break;
        case 'failed_already_checked_in':
          displayMessage("Already checked in", "warning");
          break;
        case 'failed_expired_qrcode':
          displayMessage("QR code has expired", "error");
          break;
        case 'failed_ticket_not_valid':
          displayMessage(`Ticket is not valid (${data.ticketStatus || 'not valid'})`, "error");
          break;
        default:
          displayMessage("Unknown status: " + data.returnStatus, "error");
      }
    })
    .catch(error => {
      displayMessage("Error: " + error.message, "error");
      console.error('Check-in error:', error);
    });
  };
  
  const displayMessage = (message, type) => {
    const statusElement = document.getElementById("check-in-status") || createStatusElement();
    statusElement.textContent = message;
    statusElement.className = "status-message " + type;
  };
  
  const createStatusElement = () => {
    const statusElement = document.createElement("div");
    statusElement.id = "check-in-status";
    statusElement.className = "status-message";
    
    // Insert it after the action container
    actionContainer.parentNode.insertBefore(statusElement, actionContainer.nextSibling);
    
    return statusElement;
  };
  
  const config = { 
    fps: 10,
    qrbox: { width: 250, height: 250 },
    aspectRatio: 1.0
  };
  
  function startScanner() {
    // Remove action buttons
    actionContainer.innerHTML = '';
    
    // Remove status message if it exists
    const statusElement = document.getElementById("check-in-status");
    if (statusElement) {
      statusElement.remove();
    }
    
    // Reset last scanned code
    lastScannedCode = null;
    
    resultContainer.textContent = "Scanning...";
    resultContainer.style.color = "#333";
    
    html5QrCode.start(
      { facingMode: "environment" }, // Use the back camera
      config,
      qrCodeSuccessCallback,
      (errorMessage) => {
        // Handle errors silently to avoid console spam
      }
    ).catch((err) => {
      resultContainer.textContent = `Error starting camera: ${err}`;
      resultContainer.style.color = "red";
    });
  }
  
  // Start the scanner when the page loads
  startScanner();
  
  // Additional styles
  const style = document.createElement('style');
  style.textContent = `
    .action-button {
      display: inline-block;
      margin: 15px 10px 0;
      padding: 10px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
    }
    
    .restart-button {
      background-color: #6c757d;
      color: white;
    }
    
    .restart-button:hover {
      background-color: #5a6268;
    }
    
    .check-in-button {
      background-color: #28a745;
      color: white;
    }
    
    .check-in-button:hover {
      background-color: #218838;
    }
    
    .logout-button {
      background-color: #dc3545;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      cursor: pointer;
      margin-left: 10px;
    }
    
    .logout-button:hover {
      background-color: #c82333;
    }
    
    .header-controls {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      margin-bottom: 15px;
    }
    
    #user-info {
      margin-right: auto;
      font-weight: bold;
      color: #495057;
    }
    
    .status-message {
      margin-top: 15px;
      padding: 10px;
      border-radius: 4px;
      text-align: center;
    }
    
    .status-message.success {
      background-color: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    
    .status-message.error {
      background-color: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
    
    .status-message.warning {
      background-color: #fff3cd;
      color: #856404;
      border: 1px solid #ffeeba;
    }
    
    .status-message.loading {
      background-color: #e2e3e5;
      color: #383d41;
      border: 1px solid #d6d8db;
    }
  `;
  document.head.appendChild(style);
});
