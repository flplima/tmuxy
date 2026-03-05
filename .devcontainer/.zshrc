export LANG='en_US.UTF-8'
export LANGUAGE='en_US:en'
export LC_ALL='en_US.UTF-8'
export TERM=xterm

export HISTFILE=/commandhistory/.bash_history
export HISTSIZE=10000
export SAVEHIST=10000
setopt APPEND_HISTORY
setopt SHARE_HISTORY

export PATH=/usr/local/cargo/bin:$PATH

# Pure prompt
fpath+=(/home/node/.zsh/pure)
autoload -U promptinit; promptinit
prompt pure
