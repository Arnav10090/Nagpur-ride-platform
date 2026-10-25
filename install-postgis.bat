@echo off
xcopy "C:\Users\Asus\Downloads\postgis-extracted\postgis-bundle-pg18-3.6.2x64\bin\*" "C:\Program Files\PostgreSQL\18\bin\" /Y /E /Q
xcopy "C:\Users\Asus\Downloads\postgis-extracted\postgis-bundle-pg18-3.6.2x64\lib\*" "C:\Program Files\PostgreSQL\18\lib\" /Y /E /Q
xcopy "C:\Users\Asus\Downloads\postgis-extracted\postgis-bundle-pg18-3.6.2x64\share\*" "C:\Program Files\PostgreSQL\18\share\" /Y /E /Q
net stop postgresql-x64-18
net start postgresql-x64-18
echo DONE > "C:\Users\Asus\Downloads\nagpur-ride-platform\nagpur-ride-platform\postgis-install-done.txt"
