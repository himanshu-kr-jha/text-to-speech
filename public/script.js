// Function to format text (bold, italic, underline)
function formatText(command) {
    document.execCommand(command, false, null);
}

// Change the font of the editor content
function changeFont(font) {
    document.execCommand('fontName', false, font);
}

// Change the text color
function changeColor(color) {
    document.execCommand('foreColor', false, color);
}

// Function to handle the submission, generate a .txt file, and upload to S3
// Function to handle the submission and send content to the backend API
function submitContent() {
    const editorContent = document.getElementById('textEditor').innerText;
    
    if (!editorContent.trim()) {
        alert('Content cannot be empty!');
        return;
    }

    // Send a POST request to the server
    fetch('/submit-editor', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: editorContent }),
    })
    .then(response => response.json())
    .then(data => {
        if (data.url) {
            alert('File uploaded successfully! You can access it here: ' + data.url);
        } else {
            alert('Error uploading file.');
        }
    })
    .catch(error => {
        console.error('Error:', error);
        alert('Error uploading file.');
    });
}
