FROM node:6

RUN useradd --user-group --create-home --shell /bin/false service

ENV HOME=/home/service
RUN mkdir -p $HOME/api-attachments-write

RUN npm install pm2 -g

COPY package.json $HOME/api-attachments-write
RUN chown -R service:service $HOME/*

USER service
WORKDIR $HOME/api-attachments-write
RUN npm install

USER root
COPY . $HOME/api-attachments-write
RUN chown -R service:service $HOME/*
USER service

CMD ["node", "index.js"]
