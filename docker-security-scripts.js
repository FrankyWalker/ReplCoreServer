const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = './docker_scripts';

if (!fs.existsSync(SCRIPTS_DIR)) {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

const restrictDirectoryScript = `
# Prevent navigation outside of the Rust project
cd() {
    local target_dir="$1"
    if [[ -z "$target_dir" ]]; then
        command cd /usr/src/app
    elif [[ "$target_dir" == /* && "$target_dir" != "/usr/src/app"* ]]; then
        echo "⛔ Access denied: You cannot navigate outside the Rust project directory."
        return 1
    else
        command cd "$@"
    fi
}

# Also secure the pushd command
pushd() {
    local target_dir="$1"
    if [[ -z "$target_dir" ]]; then
        command pushd /usr/src/app
    elif [[ "$target_dir" == /* && "$target_dir" != "/usr/src/app"* ]]; then
        echo "⛔ Access denied: You cannot navigate outside the Rust project directory."
        return 1
    else
        command pushd "$@"
    fi
}

# Secure the popd command based on current directory
popd() {
    local current_dir=$(pwd)
    local parent_dir=$(command cd .. && pwd)
    
    if [[ "$parent_dir" != "/usr/src/app"* && "$parent_dir" != "$current_dir" ]]; then
        echo "⛔ Access denied: This would navigate outside the Rust project directory."
        return 1
    else
        command popd "$@"
    fi
}

# Force starting directory to be the project root
cd /usr/src/app
`;

/**
 * Script to setup the container environment
 * This includes all the security measures and setup steps
 */
const setupContainerScript = `
# Update and install necessary packages
apt-get update && apt-get install -y \\
    curl \\
    git \\
    zsh \\
    wget \\
    vim \\
    nano \\
    fonts-powerline \\
    && rm -rf /var/lib/apt/lists/*

# Install Oh My Zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended

# Set ZSH as default shell
chsh -s $(which zsh)

# Configure Oh My Zsh with a nice theme
sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="agnoster"/' ~/.zshrc

# Create a basic Rust project structure if it doesn't exist
if [ ! -d "/usr/src/app" ]; then
    mkdir -p /usr/src/app
    cd /usr/src/app
    if [ ! -f "Cargo.toml" ]; then 
        cargo init --name rust_project
    fi
fi

# Setup directory restrictions for bash
echo '${restrictDirectoryScript}' >> ~/.bashrc

# Setup directory restrictions for zsh
echo '${restrictDirectoryScript}' >> ~/.zshrc

# Add custom prompt showing restricted environment
echo 'PS1="Project \$ "' >> ~/.bashrc
echo 'PROMPT="Project %# "' >> ~/.zshrc

# Remove potentially dangerous commands
for cmd in chmod chown sudo su; do
    if [ -f "/usr/bin/$cmd" ]; then
        mv "/usr/bin/$cmd" "/usr/bin/$cmd.disabled"
    fi
done

# Create a message of the day to remind users about restrictions
echo '
===============================================
🚨 SECURE RUST SANDBOX ENVIRONMENT 🚨
===============================================
• You are in a restricted Docker container
• Navigation outside the Rust project is not allowed
• This environment is for educational purposes only
===============================================
' > /etc/motd

# Display MOTD on login
echo 'cat /etc/motd' >> ~/.bashrc
echo 'cat /etc/motd' >> ~/.zshrc
`;

/**
 * Script to create a secure Dockerfile
 * @param {string} workspacePath - Path to write the Dockerfile
 */
const createSecureDockerfile = (workspacePath) => {
    const dockerfile = `
FROM rust:latest

# Copy security scripts
COPY ./security_setup.sh /tmp/security_setup.sh
RUN chmod +x /tmp/security_setup.sh && /tmp/security_setup.sh

# Create a basic Rust project structure only if it doesn't exist
WORKDIR /usr/src/app
RUN if [ ! -f "Cargo.toml" ]; then cargo init --name rust_project; fi

# Additional environment configuration
ENV RUST_BACKTRACE=1
ENV PATH="/usr/src/app/target/debug:\${PATH}"

# Keep container running
CMD ["tail", "-f", "/dev/null"]
`;

    fs.writeFileSync(path.join(workspacePath, "Dockerfile"), dockerfile);
    
    fs.writeFileSync(path.join(workspacePath, "security_setup.sh"), setupContainerScript);
};


/**
 * Generates custom scripts for specific purposes
 * @param {string} scriptType - Type of script to generate
 * @returns {string} - The generated script content
 */
const generateScript = (scriptType) => {
    switch(scriptType) {
        case 'restrict-directory':
            return restrictDirectoryScript;
        case 'setup-container':
            return setupContainerScript;
        default:
            return '';
    }
};

module.exports = {
    createSecureDockerfile,
    generateScript,
    restrictDirectoryScript,
    setupContainerScript
};